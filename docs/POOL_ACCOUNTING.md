# Setwise pool accounting

How Sets track inventory, which tokens are supported, and how native assets are represented.

## Recorded versus actual balances

Each supported asset has two balances:

| Balance      | Source                                                  | Used for                                                           |
| ------------ | ------------------------------------------------------- | ------------------------------------------------------------------ |
| **Recorded** | `_recordedBalances[token]` via `recordedBalance(token)` | Swap settlement, proportional withdrawals, packed invariant checks |
| **Actual**   | ERC-20 `balanceOf(pool)`                                | Portfolio deposits (sanity check), operator monitoring             |

### `SetwisePool` (base implementation)

- Swaps update recorded balances directly (`increaseBalance` / `decreaseBalance`) without comparing to `balanceOf` on
  every swap (gas optimization).
- `depositPortfolio` transfers tokens in, then requires `balanceOf(pool) - recordedBalance >= depositAmount` before
  syncing recorded balance to actual.
- `depositSingleAsset` increases recorded balance by the transferred amount.
- `withdrawPortfolio` transfers proportional shares of **recorded** balances and calls `_sync` per asset so recorded
  balances match `balanceOf` after transfer.

### Drift implications

If actual `balanceOf` exceeds recorded balance (donation, airdrop, or manual transfer), swaps on `SetwisePool` may
succeed while recorded inventory understates reality. The RFQ API compares both and surfaces drift warnings; operators
should reconcile before relying on pricing.

If actual balance falls below recorded balance, swaps and withdrawals that debit recorded balance can revert on
`safeTransfer` even when the signature is valid.

`SetwiseRebalancingPool` swap paths set recorded balances from the pre-trade recorded values plus signed deltas after
the packed guard passes; they do not re-read `balanceOf` during swaps.

## Supported assets

- Initialized from the `supportedAssets` array at proxy deployment.
- `SetwisePool.addAsset(address)` allows the owner to add a token and sync recorded balance from `balanceOf`.
- `isSupportedAsset`, `assetCount`, and `assetAt` expose the allowlist.
- Asset order is stable for the life of the Set unless upgraded; `depositPortfolio` arrays follow `assetAt(0..n-1)`.

There is no onchain asset-removal flow yet (repository TODO). Integrators should treat the deployed manifest and
`portfolioState()` as authoritative.

## Native token assumptions

- `WRAPPED_NATIVE_TOKEN` is set at initialization and exposed as an immutable-style storage slot.
- Internal sentinel `NATIVE_TOKEN = address(0)` is used only inside `withdrawSingleAsset` to select unwrap-and-send-ETH
  behavior; it must not appear in EIP-712 quotes.
- `swapExactNativeForAsset` accepts ETH, forwards it to the wrapped-native contract, and credits wrapped-native recorded
  balance.
- `swapExactAssetForNative` debits wrapped-native recorded balance, unwraps, and sends ETH to `recipient`.
- The pool `receive()` accepts ETH; unexpected ETH does not automatically update recorded balances.

Wallets that cannot receive native currency should request wrapped-native output via `swapExactAssetForAsset` instead of
`swapExactAssetForNative`.

## LP share token

- Name: `Setwise Portfolio Share`
- Symbol: `SETWISE`
- `SetwiseRebalancingPool` adds ERC-2612 permit (`"Setwise Portfolio Share"` permit name).
- Vesting deposits mint shares to the pool contract until `claimShares()` after `lockDays`.

## Portfolio state snapshot

`portfolioState()` returns:

```solidity
(uint256[] balances, address[] tokens, uint256 totalSupply)
```

Balances are **recorded** balances aligned with `assetAt` order. The RFQ API reads this view at a pinned block for
pricing and firm-quote guards.

## Terminology

User-facing surfaces describe these structures as **Sets**. Contract storage, manifests, and the RFQ `poolId` field
retain `pool` naming.
