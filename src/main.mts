import fetch from "node-fetch";
import { ContractTag, ITagService } from "atq-types";

// Fraxlend lending pair contracts, one tag per pair.
//
// A Pair's id is the FraxlendPair contract itself: the subgraph reports the
// same value in its `address` field, and it is distinct from the asset and
// collateral token addresses, which belong to their own issuers and are never
// tagged here.
//
// The pair's own ERC20 symbol is used for the tag because it carries the
// asset, the collateral and the pair index, e.g. "fFRAX(ARB)-1". Two pairs can
// share an asset and a collateral, so the index is what keeps every tag on a
// chain distinct.
//
// The Fraxtal deployment is deliberately absent: it carries a non-zero
// deniedAt on the network and is served unreliably.

interface ChainConfig {
  network: string;
  deploymentId: string;
}

// Chain ID -> Fraxlend subgraph deployment on The Graph's decentralised
// network. Frax names the publishing account in its own documentation at
// https://docs.frax.com/protocol/integration/api
const CHAIN_CONFIGS: Readonly<Record<string, ChainConfig>> = {
  "1": { network: "Ethereum", deploymentId: "QmSWZDbG2ezGjGhuRELuv9quzgs5wHusz7brFUq8CMb5uk" },
  "988": { network: "Stable", deploymentId: "QmetWPs5US8E1SNjd3Zw1nycegULa4oAGJzspuowBUeakW" },
  "42161": { network: "Arbitrum One", deploymentId: "QmRKm6THtyr3Ej73LF9jVe4GdSiq1sMQg4XVip6axvLdHm" },
};

const PROJECT_NAME = "Fraxlend";
const PROJECT_URL = "https://app.frax.finance/fraxlend/available-pairs";
const PAGE_SIZE = 1000;
const MAX_NAME_TAG = 50;
const NAME_TAG_SUFFIX = " Lending Pair";

interface Token {
  symbol: string | null;
  name: string | null;
}

interface Pair {
  id: string;
  address: string | null;
  symbol: string | null;
  asset: Token | null;
  collateral: Token | null;
}

interface GraphQLResponse {
  data?: { pairs?: Pair[] };
  errors?: { message: string }[];
}

const headers: Record<string, string> = {
  "Content-Type": "application/json",
  Accept: "application/json",
};

// Cursor pagination on the entity id. Offset pagination is not permitted and
// would silently truncate past the skip limit.
const GET_PAIRS_QUERY = `
query GetPairs($lastId: ID!) {
  pairs(
    first: ${PAGE_SIZE}
    orderBy: id
    orderDirection: asc
    where: { id_gt: $lastId }
  ) {
    id
    address
    symbol
    asset {
      symbol
      name
    }
    collateral {
      symbol
      name
    }
  }
}
`;

const isError = (e: unknown): e is Error =>
  typeof e === "object" && e !== null && "message" in e;

const containsHtml = (text: string): boolean => /<[^>]*>/.test(text);

const isUsable = (text: string | null | undefined): boolean =>
  typeof text === "string" && text.trim().length > 0 && !containsHtml(text);

const truncate = (text: string, maxLength: number): string =>
  text.length > maxLength ? `${text.substring(0, maxLength - 3)}...` : text;

const trimmed = (value: string | null | undefined): string =>
  typeof value === "string" ? value.trim() : "";

const buildUrl = (chainId: string, apiKey: string): string => {
  const config = CHAIN_CONFIGS[chainId];
  if (!config) {
    const supported = Object.keys(CHAIN_CONFIGS).join(", ");
    throw new Error(
      `Unsupported Chain ID: ${chainId}. Supported Chain IDs are: ${supported}.`
    );
  }
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new Error("An API key must be provided to returnTags.");
  }
  return `https://gateway.thegraph.com/api/${apiKey}/deployments/id/${config.deploymentId}`;
};

const fetchPairs = async (url: string, lastId: string): Promise<Pair[]> => {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: GET_PAIRS_QUERY, variables: { lastId } }),
  });

  if (!response.ok) {
    throw new Error(
      `The Fraxlend subgraph returned HTTP ${response.status} ${response.statusText}.`
    );
  }

  const result = (await response.json()) as GraphQLResponse;

  if (result.errors && result.errors.length > 0) {
    const detail = result.errors.map((e) => e.message).join("; ");
    throw new Error(`The Fraxlend subgraph returned errors: ${detail}.`);
  }
  if (!result.data || !Array.isArray(result.data.pairs)) {
    throw new Error("The Fraxlend subgraph returned no pairs field.");
  }
  return result.data.pairs;
};

const toTags = (chainId: string, pairs: Pair[]): ContractTag[] => {
  const config = CHAIN_CONFIGS[chainId];
  const tags: ContractTag[] = [];

  for (const pair of pairs) {
    if (typeof pair.id !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(pair.id)) {
      throw new Error(
        `The Fraxlend subgraph returned an invalid pair address: ${String(pair.id)}.`
      );
    }
    // The subgraph reports the contract twice; disagreement means the entity is
    // not describing the contract it claims to.
    const address = trimmed(pair.address);
    if (address !== "" && address.toLowerCase() !== pair.id.toLowerCase()) {
      throw new Error(
        `The Fraxlend subgraph returned a pair whose id ${pair.id} disagrees with its address ${address}.`
      );
    }

    const pairSymbol = trimmed(pair.symbol);
    const assetSymbol = trimmed(pair.asset ? pair.asset.symbol : null);
    const collateralSymbol = trimmed(pair.collateral ? pair.collateral.symbol : null);
    if (!isUsable(pairSymbol) || !isUsable(assetSymbol) || !isUsable(collateralSymbol)) {
      continue;
    }
    const assetName = trimmed(pair.asset ? pair.asset.name : null);
    const collateralName = trimmed(pair.collateral ? pair.collateral.name : null);
    const lends = isUsable(assetName) ? assetName : assetSymbol;
    const against = isUsable(collateralName) ? collateralName : collateralSymbol;

    const nameTag = `${truncate(
      pairSymbol,
      MAX_NAME_TAG - NAME_TAG_SUFFIX.length
    )}${NAME_TAG_SUFFIX}`;

    tags.push({
      "Contract Address": `eip155:${chainId}:${pair.id}`,
      "Public Name Tag": nameTag,
      "Project Name": PROJECT_NAME,
      "UI/Website Link": PROJECT_URL,
      "Public Note": `Fraxlend's isolated lending pair (Symbol: ${pairSymbol}), lending ${lends} (Symbol: ${assetSymbol}) against ${against} (Symbol: ${collateralSymbol}) as collateral, on the ${config.network} network.`,
    });
  }
  return tags;
};

class TagService implements ITagService {
  returnTags = async (chainId: string, apiKey: string): Promise<ContractTag[]> => {
    if (typeof chainId !== "string") {
      throw new Error("The Chain ID must be provided as a decimal string.");
    }

    const url = buildUrl(chainId, apiKey);
    const allTags: ContractTag[] = [];
    const seen = new Set<string>();
    let lastId = "";
    let more = true;

    while (more) {
      let pairs: Pair[];
      try {
        pairs = await fetchPairs(url, lastId);
      } catch (error) {
        if (isError(error)) {
          throw new Error(`Failed fetching Fraxlend pairs: ${error.message}`);
        }
        throw new Error("Failed fetching Fraxlend pairs: unknown error.");
      }

      for (const tag of toTags(chainId, pairs)) {
        const address = tag["Contract Address"];
        if (seen.has(address)) {
          throw new Error(`The Fraxlend subgraph returned a duplicate pair: ${address}.`);
        }
        seen.add(address);
        allTags.push(tag);
      }

      more = pairs.length === PAGE_SIZE;
      if (more) {
        const nextId = pairs[pairs.length - 1].id;
        if (nextId === lastId) {
          throw new Error("Pagination cursor did not advance; aborting to avoid a loop.");
        }
        lastId = nextId;
      }
    }

    if (allTags.length === 0) {
      throw new Error(
        `The Fraxlend subgraph returned no usable pairs for Chain ID ${chainId}.`
      );
    }
    return allTags;
  };
}

const tagService = new TagService();

export const returnTags = tagService.returnTags;
