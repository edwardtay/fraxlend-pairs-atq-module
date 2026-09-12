# fraxlend-pairs-atq-module

Returns one `ContractTag` per Fraxlend isolated lending pair.

`returnTags(chainId, apiKey)` queries the Fraxlend subgraph for that chain
through The Graph's decentralised network and returns a tag for each
FraxlendPair contract.

The asset and collateral tokens are not Fraxlend contracts and are never
tagged.

## Subgraphs

Frax names its publishing account in its own documentation at
<https://docs.frax.com/protocol/integration/api>:

> Subgraphs: https://thegraph.com/explorer/profile/0x6e74053a3798e0fc9a9775f7995316b27f21c4d2?view=Subgraphs

| Chain ID | Network | Deployment |
|---|---|---|
| 1 | Ethereum | `QmSWZDbG2ezGjGhuRELuv9quzgs5wHusz7brFUq8CMb5uk` |
| 988 | Stable | `QmetWPs5US8E1SNjd3Zw1nycegULa4oAGJzspuowBUeakW` |
| 42161 | Arbitrum One | `QmRKm6THtyr3Ej73LF9jVe4GdSiq1sMQg4XVip6axvLdHm` |

Fraxtal (252) is deliberately excluded: its Fraxlend deployment carries a
non-zero `deniedAt` on the network and is served unreliably.

## Build and verify

```
yarn install
yarn build
node tools/verify.mjs 1 <YOUR_GRAPH_API_KEY>
```
