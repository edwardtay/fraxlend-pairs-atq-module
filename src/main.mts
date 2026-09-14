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
// deniedAt on the network and is served unreliably. The Stable deployment is
// absent too: it has no curation signal and its only allocation belongs to The
// Graph's upgrade indexer, which the registry policy treats as unavailable.

interface ChainConfig {
  network: string;
  deploymentId: string;
}

// Chain ID -> Fraxlend subgraph deployment on The Graph's decentralised
// network. Frax names the publishing account in its own documentation at
// https://docs.frax.com/protocol/integration/api
const CHAIN_CONFIGS: Readonly<Record<string, ChainConfig>> = {
  "1": { network: "Ethereum", deploymentId: "QmSWZDbG2ezGjGhuRELuv9quzgs5wHusz7brFUq8CMb5uk" },
  "42161": { network: "Arbitrum One", deploymentId: "QmRKm6THtyr3Ej73LF9jVe4GdSiq1sMQg4XVip6axvLdHm" },
};

const PROJECT_NAME = "Fraxlend";
const PROJECT_URL = "https://app.frax.finance/fraxlend/available-pairs";
const PAGE_SIZE = 1000;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_NAME_TAG = 50;
const NAME_TAG_SUFFIX = " Lending Pair";

interface Token {
  symbol: string | null;
  name: string | null;
}

interface Pair {
  id: string;
  address: string | null;
  name: string | null;
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
    name
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
  // An own-property check, so inherited names such as "constructor" are rejected
  // as unsupported instead of reaching the network.
  if (!Object.prototype.hasOwnProperty.call(CHAIN_CONFIGS, chainId)) {
    const supported = Object.keys(CHAIN_CONFIGS).join(", ");
    throw new Error(
      `Unsupported Chain ID: ${chainId}. Supported Chain IDs are: ${supported}.`
    );
  }
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new Error("An API key must be provided to returnTags.");
  }
  const config = CHAIN_CONFIGS[chainId];
  // The key is trimmed and encoded, so characters such as "/" or "?" cannot
  // change the gateway path the request is sent to.
  return `https://gateway.thegraph.com/api/${encodeURIComponent(
    apiKey.trim()
  )}/deployments/id/${config.deploymentId}`;
};

const fetchPairs = async (url: string, lastId: string): Promise<Pair[]> => {
  // Every request is bounded, so a gateway that stops responding produces an
  // Error instead of leaving the call pending indefinitely.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let result: GraphQLResponse;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: GET_PAIRS_QUERY, variables: { lastId } }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `The Fraxlend subgraph returned HTTP ${response.status} ${response.statusText}.`
      );
    }

    result = (await response.json()) as GraphQLResponse;
  } catch (error) {
    if (isError(error) && error.name === "AbortError") {
      throw new Error(
        `The Fraxlend subgraph did not respond within ${REQUEST_TIMEOUT_MS / 1000} seconds.`
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

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
    // A pair whose own symbol, asset symbol or collateral symbol is missing or
    // malformed cannot be named or described accurately, so it is skipped rather
    // than tagged with a placeholder.
    if (!isUsable(pairSymbol) || !isUsable(assetSymbol) || !isUsable(collateralSymbol)) {
      continue;
    }
    // The earliest pairs carry no index in their symbol ("FraxlendV1 - CRV/FRAX"),
    // so two pairs over the same assets would share a tag. Their ERC-20 name ends
    // with the pair index, which is appended to keep every tag on a chain distinct.
    const nameIndex = /-\s*(\d+)\s*$/.exec(trimmed(pair.name));
    const pairLabel =
      /-\d+$/.test(pairSymbol) || nameIndex === null ? pairSymbol : `${pairSymbol}-${nameIndex[1]}`;
    const assetName = trimmed(pair.asset ? pair.asset.name : null);
    const collateralName = trimmed(pair.collateral ? pair.collateral.name : null);
    const lends = isUsable(assetName) ? assetName : assetSymbol;
    const against = isUsable(collateralName) ? collateralName : collateralSymbol;

    const nameTag = `${truncate(
      pairLabel,
      MAX_NAME_TAG - NAME_TAG_SUFFIX.length
    )}${NAME_TAG_SUFFIX}`;

    tags.push({
      "Contract Address": `eip155:${chainId}:${pair.id}`,
      "Public Name Tag": nameTag,
      "Project Name": PROJECT_NAME,
      "UI/Website Link": PROJECT_URL,
      "Public Note": `Fraxlend's isolated lending pair and its ERC-20 share token (Symbol: ${pairSymbol}), lending ${lends} (Symbol: ${assetSymbol}) against ${against} (Symbol: ${collateralSymbol}) as collateral, on the ${config.network} network.`,
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
