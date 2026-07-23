# Setwise pool security and operations

Security assumptions, emergency controls, and operational limits for deployed Sets.

> These contracts have not completed an independent security audit. Do not deploy with real funds without audit and
> operational readiness review.

## Trust and threat model

| Actor            | Capability                                                   | Assumption                                                        |
| ---------------- | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| **Pool owner**   | UUPS upgrade, `addAsset`, `setGuardian`                      | Honest or timelocked multisig in production                       |
| **Quote signer** | Authorizes all signed deposits, withdrawals, and swaps       | Compromise allows arbitrary signed flows until key rotation       |
| **Guardian**     | `pauseTrading` / `resumeTrading` on `SetwiseRebalancingPool` | Can halt trading but cannot upgrade or move funds alone           |
| **Any user**     | `withdrawPortfolio` without a quote                          | Can exit proportionally unless trading pause blocks related paths |

Integrators must treat signed quotes as bearer authorizations until consumed. The pool does not validate off-chain
pricing beyond signature, deadline, replay guard, and (for rebalancing Sets) packed inventory guard.

## Trading pause (`SetwiseRebalancingPool`)

| Selector     | Function          | Caller     |
| ------------ | ----------------- | ---------- |
| `0x1031e36e` | `pauseTrading()`  | `guardian` |
| `0x0694db1e` | `resumeTrading()` | `guardian` |
| `0x452a9320` | `guardian()`      | view       |

When `isTradingPaused()` is true:

- Swaps, deposits, and `withdrawSingleAsset` revert `TradingPaused()`.
- `withdrawPortfolio` and `claimShares` remain available so LPs can exit proportionally.

`setGuardian(address)` is `onlyOwner`. Setting guardian to `address(0)` disables pause until a new guardian is assigned.

## Ownership and upgrades

- Pools deploy as UUPS proxies (`SetwiseRebalancingPool`).
- **Proxy address** is the integration address; **implementation** changes on upgrade.
- `_authorizeUpgrade` is `onlyOwner`.
- Run [`scripts/upgrade.ts`](../scripts/upgrade.ts) only after storage-layout validation and full test suite pass.

Production deployments should use a Safe or timelock as `poolOwner`, not an EOA deployer.

## Quote signer

- Set at initialization as `QUOTE_SIGNER`.
- Verified via OpenZeppelin `SignatureChecker` (EOA and ERC-1271).
- **Onchain rotation is not implemented yet** (repository TODO). Rotating a compromised signer today requires an
  owner-gated implementation upgrade or redeployment.
- Off-chain services (`rfq-api`) must hold the private key matching `QUOTE_SIGNER`; never commit it.

Until rotation ships, operational response to signer compromise is:

1. Guardian `pauseTrading()` on affected Sets.
2. Deploy upgraded implementation with new signer **or** redeploy proxy (migration).
3. Update RFQ configuration and manifests.

## Reentrancy and approvals

- Asset-moving externals use `nonReentrant`.
- ERC-20 inputs use `safeTransferFrom(msg.sender, ...)`; callers must approve the pool (or router must hold allowance
  when acting as payer).
- Fee-on-transfer, rebasing, and false-returning tokens are unsupported.

## Emergency checklist

1. **Suspicious quotes or inventory drift** — guardian pauses trading; RFQ stops issuing firm quotes.
2. **Signer compromise** — pause, rotate via upgrade/redeploy, invalidate outstanding quotes off-chain.
3. **Implementation bug** — owner upgrades to patched implementation after validation.
4. **Stuck inventory** — proportional `withdrawPortfolio` remains available while paused.

## Explicit non-goals (security scope)

The pool contracts do **not**:

- Enforce router-level execution authorization (handled in `setwise-router`).
- Cancel quotes except by expiry or one-time consumption.
- Emit `quoteId` in `SwapExecuted` yet.
- Validate external market prices onchain.
- Recover mistakenly sent tokens (no generic sweep).

See [`POOL_INTEGRATION.md`](./POOL_INTEGRATION.md) for router and RFQ boundaries.

## Terminology

Emergency runbooks and user notifications should refer to pausing a **Set**. Configuration files and onchain roles keep
`pool` / `poolOwner` naming.
