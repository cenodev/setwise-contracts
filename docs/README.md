# Setwise pool documentation

Published reference for integrating with Setwise onchain Sets (liquidity pools). Router, RFQ API, operator, and audit
consumers should start here instead of reading implementation internals.

User-facing UI copy says **Set** when referring to Setwise liquidity. Internal identifiers, contract fields, deployment
manifests, and RFQ configuration keep `pool` / `poolId`.

## Guides

| Document                                       | Audience                       | Contents                                                                                                                        |
| ---------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| [`POOL_INTERFACE.md`](./POOL_INTERFACE.md)     | Router, RFQ, wallet developers | Swap entry points, EIP-712 message types, payer/recipient rules, quote IDs, deadlines, packed balance guards, replay protection |
| [`POOL_ACCOUNTING.md`](./POOL_ACCOUNTING.md)   | RFQ pricing, operators         | Recorded versus actual balances, supported assets, native-token encoding                                                        |
| [`POOL_SECURITY.md`](./POOL_SECURITY.md)       | Operators, auditors            | Pause controls, ownership and upgrades, quote-signer assumptions, emergency procedures                                          |
| [`POOL_DEPLOYMENTS.md`](./POOL_DEPLOYMENTS.md) | Integrators, DevOps            | Per-chain proxy addresses, manifests, ABI paths, explorer and verification status                                               |
| [`POOL_INTEGRATION.md`](./POOL_INTEGRATION.md) | Router and RFQ maintainers     | Integration invariants, explicit non-goals, cross-repo update checks                                                            |

## Machine-readable baseline

[`baseline/pool-interface.json`](./baseline/pool-interface.json) captures selectors, EIP-712 typehashes, events, and
errors checked against compiled artifacts in [`test/docs/poolDocs.ts`](../test/docs/poolDocs.ts).

Regenerate the baseline only after a deliberate contract interface change:

```sh
npm run compile
npm test -- --grep "pool documentation"
```

## Ownership and update checks

| Change type                                | Owner                           | Required checks                                                                                                                                                               |
| ------------------------------------------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Swap ABI, EIP-712 types, events, or errors | `setwise-contracts`             | Update `docs/baseline/pool-interface.json`, `docs/POOL_INTERFACE.md`, `npm test`, `npm run lint`; notify `setwise-router` (issue #7 baseline) and `rfq-api` (artifact import) |
| Packed swap deadline encoding              | `setwise-contracts` + `rfq-api` | Update `POOL_INTERFACE.md`, `rfq-api` `packSwapDeadline` tests, and this baseline if selectors change                                                                         |
| New chain deployment                       | `setwise-contracts`             | Add manifest under `deployments/`, RFQ config JSON, row in `POOL_DEPLOYMENTS.md`, run deployment doc tests                                                                    |
| Guardian pause or owner rotation           | Operations                      | Update `POOL_DEPLOYMENTS.md` and operator runbooks; no ABI change                                                                                                             |
| UUPS implementation upgrade                | `setwise-contracts`             | Storage-compatible implementation only; update implementation address in deployment manifest; re-run `npm test` and upgrade script dry run                                    |

Before merging contract changes that affect integrators:

1. `npm run compile`
2. `npm test`
3. `npm run lint`
4. `npx tsc --noEmit`
5. Confirm `docs/baseline/pool-interface.json` still matches artifacts (covered by `test/docs/poolDocs.ts`).

Related repositories:

- [`cenodev/setwise-router`](https://github.com/cenodev/setwise-router) — onchain execution and router authorization
- [`cenodev/rfq-api`](https://github.com/cenodev/rfq-api) — indicative and firm off-chain quotes
