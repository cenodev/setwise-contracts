# Setwise pool deployments

Per-chain Set (pool) proxy addresses, manifests, ABI locations, and verification status.

The **proxy** is the integration address. Record both proxy and implementation after every deploy or upgrade.

## Supported chains

| Network                   | Chain ID | Status  | Primary manifest                                                                | RFQ config                                                                                                      |
| ------------------------- | -------: | ------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| BSC Testnet               |       97 | Testnet | [`deployments/bsc-testnet.json`](../deployments/bsc-testnet.json)               | [`deployments/bsc-testnet.rfq-pool-config.json`](../deployments/bsc-testnet.rfq-pool-config.json)               |
| BSC Testnet (no WBNB Set) |       97 | Testnet | [`deployments/bsc-testnet.no-bnb.json`](../deployments/bsc-testnet.no-bnb.json) | [`deployments/bsc-testnet.no-bnb.rfq-pool-config.json`](../deployments/bsc-testnet.no-bnb.rfq-pool-config.json) |

No production mainnet Sets are documented in this repository yet.

## BSC Testnet — BStock AI Set (with WBNB)

| Field            | Value                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Set proxy        | [`0x62809EC4C6295177eD322090edf0f13F89442dAE`](https://testnet.bscscan.com/address/0x62809EC4C6295177eD322090edf0f13F89442dAE) |
| Implementation   | `0xCC1A88C7C0f01f54dE8d47DAA05e4FF9CE3F6330`                                                                                   |
| Owner            | `0x0B37DDA72EbC2E9Cd177D1455139e7355d3a9e50`                                                                                   |
| Quote signer     | `0x0B37DDA72EbC2E9Cd177D1455139e7355d3a9e50`                                                                                   |
| Wrapped native   | `0x119FF2a8b74dfCE4c378CE4bd2c10201bf47e395`                                                                                   |
| RFQ `poolId`     | `bstock-ai-bsc-testnet`                                                                                                        |
| Contract version | `2.0.0`                                                                                                                        |
| Deploy script    | [`scripts/deploy-bsc-testnet.ts`](../scripts/deploy-bsc-testnet.ts)                                                            |

### Source and ABI

| Artifact           | Path                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Implementation ABI | [`artifacts/contracts/SetwiseRebalancingPool.sol/SetwiseRebalancingPool.json`](../artifacts/contracts/SetwiseRebalancingPool.sol/SetwiseRebalancingPool.json) |
| Sources            | `contracts/SetwisePoolBase.sol`, `SetwisePool.sol`, `SetwiseRebalancingPool.sol`                                                                              |

Generate typings after compile: `npm run compile`.

### Explorer verification

Proxy and implementation verification on BscScan is **pending** (see root README TODO). Until verified, use the manifest
and local artifacts as the source of truth.

### Related testnet assets

Mock token addresses, faucet configuration, and app manifest:

- [`deployments/bsc-testnet.json`](../deployments/bsc-testnet.json) — full deployment record
- [`deployments/bsc-testnet.app-config.json`](../deployments/bsc-testnet.app-config.json) — app/faucet slice
- [`docs/FAUCET_RUNBOOK.md`](./FAUCET_RUNBOOK.md) — faucet operations

## BSC Testnet — BStock AI Set (no WBNB)

Second testnet Set reusing mock tokens but excluding WBNB from supported assets and bootstrap portfolio. WBNB weight is
reassigned to USDT.

| Field            | Value                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Set proxy        | [`0xA54D041eD831BBE2D6F97107Ab3aD9f9682C392a`](https://testnet.bscscan.com/address/0xA54D041eD831BBE2D6F97107Ab3aD9f9682C392a) |
| Implementation   | `0xCC1A88C7C0f01f54dE8d47DAA05e4FF9CE3F6330` (shared with WBNB Set)                                                            |
| RFQ `poolId`     | `bstock-ai-no-bnb-bsc-testnet`                                                                                                 |
| Deploy script    | [`scripts/deploy-no-bnb-pool-bsc-testnet.ts`](../scripts/deploy-no-bnb-pool-bsc-testnet.ts)                                    |
| Liquidity top-up | [`scripts/top-up-no-bnb-pool-bsc-testnet.ts`](../scripts/top-up-no-bnb-pool-bsc-testnet.ts)                                    |

Manifest may include `liquidityTopUps` history; see `deployments/bsc-testnet.no-bnb.json`.

## Deploying a new Set

### Existing asset universe

```sh
export SETWISE_QUOTE_SIGNER=<signer>
export SETWISE_WRAPPED_NATIVE_TOKEN=<wrapped-native>
export SETWISE_ASSETS=<comma-separated asset addresses>
npm run deploy:contracts -- --network <network>
```

### BSC Testnet mocks

See root [`README.md`](../README.md#bsc-testnet-with-mock-bstocks).

## Upgrades

```sh
export SETWISE_PROXY_ADDRESS=<proxy>
npm run upgrade:bsc-testnet
```

After upgrade:

1. Update `poolImplementation` in the deployment manifest.
2. Re-run `npm test`.
3. Notify router and RFQ consumers if the ABI changed.

## Manifest fields integrators rely on

| Field                                 | Purpose                                  |
| ------------------------------------- | ---------------------------------------- |
| `poolProxy`                           | Onchain `to` address for transactions    |
| `poolImplementation`                  | Implementation tracking / upgrade audits |
| `quoteSigner`                         | Must match onchain `QUOTE_SIGNER()`      |
| `poolOwner`                           | Upgrade and guardian administration      |
| `chainId` / `network`                 | Chain validation                         |
| `mockWrappedNative` / asset addresses | RFQ asset registry                       |

RFQ pool configs add `poolAddress`, `contractVersion`, pricing policy, and asset metadata for the `rfq-api` worker.

## Terminology

User-facing deployment notices should say **Set**. JSON field names remain `poolProxy`, `poolId`, and `poolAddress` for
backward compatibility.
