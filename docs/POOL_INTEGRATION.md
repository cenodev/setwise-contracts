# Router and RFQ integration

Integration invariants and explicit non-goals for [`setwise-router`](https://github.com/cenodev/setwise-router) and
[`rfq-api`](https://github.com/cenodev/rfq-api) when executing against Sets.

Pool interface details: [`POOL_INTERFACE.md`](./POOL_INTERFACE.md).

## Integration invariants

### 1. Fixed amounts

Swaps are exact-input / exact-output at the signed amounts. The pool does not compute slippage or apply an onchain fee
curve. Off-chain pricing chooses `inputAmount` and `outputAmount`; the pool enforces them literally.

### 2. Dual authorization layers

| Layer                 | Where enforced                           | Binds                                                                     |
| --------------------- | ---------------------------------------- | ------------------------------------------------------------------------- |
| Pool `SwapQuote`      | Set contract                             | Payer (`msg.sender`), assets, amounts, `quoteId`, `deadline`, `recipient` |
| Router execution auth | Setwise Router (separate EIP-712 domain) | Funding wallet, chain, router entry point                                 |

Router integrators must satisfy **both**. See `setwise-router` `ROUTER_AUTHORIZATION.md`.

### 3. Payer is `msg.sender`

The address that submits the transaction must be the `payer` field in `SwapQuote`. Routers therefore sign with
themselves as payer while pulling user tokens via allowances or native `msg.value` forwarding.

### 4. Native normalization

Signed quotes always use `WRAPPED_NATIVE_TOKEN` for a native leg. RFQ and router adapters map UI native sentinel
(`address(0)`) to wrapped-native before signing. Never sign `address(0)` in quotes.

### 5. Packed swap deadline (rebalancing Sets)

Deployed testnet Sets use `SetwiseRebalancingPool`. Firm swap transactions must pass the **packed** deadline word from
the RFQ API, not a plain Unix expiry alone. Deposit and withdrawal firm quotes still use plain Unix deadlines.

### 6. `quoteId` consumption

Each firm quote ID is single-use onchain. Router batching and RFQ idempotency must not reuse IDs across distinct
settlements.

### 7. Asset order for portfolio deposits

`depositPortfolio` amount arrays follow `assetAt(i)` order. RFQ responses expose `orderedAtomicAmounts` with zeros for
omitted assets.

### 8. Trading pause

When `isTradingPaused()` is true, only proportional `withdrawPortfolio` and `claimShares` remain for LP flows. Router
and RFQ must surface pause state and stop firm swap/deposit paths.

### 9. Recorded balance authority

Pricing and packed guards use `recordedBalance` / `portfolioState`, not wallet `balanceOf` alone. RFQ monitors drift
between recorded and actual balances.

### 10. Artifact coupling

`rfq-api` imports `setwise-contracts/artifacts/contracts/SetwiseRebalancingPool.sol/SetwiseRebalancingPool.json`. Router
vendors a trimmed `ISetwisePool` baseline derived from the same swap surface. ABI changes require coordinated releases.

## RFQ service responsibilities

- Maintain inventory-aware pricing policy (curve, reserves, external venues).
- Issue EIP-712 signatures from the deployed `QUOTE_SIGNER` key.
- Pack swap balance guards for `SetwiseRebalancingPool`.
- Emit executable calldata (`to`, `data`, `value`) matching [`POOL_INTERFACE.md`](./POOL_INTERFACE.md).
- Expose static `poolId` registry and live `state` for each Set.

## Router responsibilities

- Select Setwise routes among other liquidity sources.
- Forward swaps with correct `msg.value` on native-in paths.
- Preserve `recipient` and `auxiliaryData` from firm quotes.
- Enforce router-level execution authorization before calling the Set.

## Explicit non-goals

### Set contracts do not

- Discover prices or select routes.
- Know about the Setwise Router or RFQ API.
- Validate that `auxiliaryData` matches off-chain intent.
- Implement quote cancellation (only expiry and consumption).
- Rotate `QUOTE_SIGNER` without an upgrade (today).
- Remove assets from the allowlist.
- Guarantee ERC-20 `balanceOf` equals recorded balance after swaps.

### RFQ API does not

- Submit transactions or hold user funds.
- Override onchain pause or replay protection.
- Guarantee indicative quotes remain executable at execution time (inventory moves).

### Setwise Router does not

- Re-sign pool quotes.
- Modify signed pool amounts or assets.
- Impose pool inventory guards (the Set enforces its own packed guard).

## Cross-repo update matrix

| Change                           | `setwise-contracts`             | `rfq-api`                 | `setwise-router`              |
| -------------------------------- | ------------------------------- | ------------------------- | ----------------------------- |
| New swap selector / EIP-712 type | baseline + docs + tests         | artifact bump + signing   | `ISetwisePool` + baseline ABI |
| Packed guard encoding change     | `SetwiseRebalancingPool` + docs | `packSwapDeadline`        | none if calldata opaque       |
| New testnet Set                  | deployment manifest + RFQ JSON  | pool config import        | pool registry entry           |
| Guardian pause                   | ops + docs                      | surface `isTradingPaused` | respect pause in routing      |
| Router execution domain          | none                            | none                      | `ROUTER_AUTHORIZATION.md`     |

## Terminology

Product copy and API responses shown to end users should say **Set** / **Set ID**. JSON fields `poolId`, `poolAddress`,
and internal router identifiers remain unchanged.
