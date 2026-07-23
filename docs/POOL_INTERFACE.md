# Setwise pool interface

Canonical onchain surface for Setwise Sets (`SetwiseRebalancingPool` UUPS proxy). The proxy address is the permanent
integration target; implementation addresses change on upgrade.

- Solidity sources: [`contracts/SetwisePoolBase.sol`](../contracts/SetwisePoolBase.sol),
  [`contracts/SetwisePool.sol`](../contracts/SetwisePool.sol),
  [`contracts/SetwiseRebalancingPool.sol`](../contracts/SetwiseRebalancingPool.sol)
- ABI artifact:
  [`artifacts/contracts/SetwiseRebalancingPool.sol/SetwiseRebalancingPool.json`](../artifacts/contracts/SetwiseRebalancingPool.sol/SetwiseRebalancingPool.json)
- Machine-readable baseline: [`baseline/pool-interface.json`](./baseline/pool-interface.json)

## How a swap works

A Set has no onchain AMM curve. A swap is RFQ execution:

1. The RFQ service signs an EIP-712 `SwapQuote` binding the **payer** (`msg.sender` at execution), input/output assets,
   fixed amounts, a one-time `quoteId`, a `deadline`, and the `recipient`.
2. The payer (wallet or router) calls the entry point matching the settlement mode and forwards the signature.
3. The pool verifies the signature against `QUOTE_SIGNER` (EOA or ERC-1271), consumes `quoteId`, enforces the deadline
   and (on `SetwiseRebalancingPool`) the packed balance guard, then settles.

Deposits and single-asset withdrawals follow the same quote-verification pattern with their own EIP-712 types.
Proportional `withdrawPortfolio` burns LP shares without a signed quote.

## Swap entry points

| Selector     | Function                                                                                      | Mutability | Mode            |
| ------------ | --------------------------------------------------------------------------------------------- | ---------- | --------------- |
| `0x24266baa` | `swapExactAssetForAsset(address,address,uint256,uint256,bytes32,uint256,address,bytes,bytes)` | nonpayable | ERC-20 → ERC-20 |
| `0xdcf8b279` | `swapExactNativeForAsset(address,uint256,uint256,bytes32,uint256,address,bytes,bytes)`        | payable    | native → ERC-20 |
| `0x695d9b7f` | `swapExactAssetForNative(address,uint256,uint256,bytes32,uint256,address,bytes,bytes)`        | nonpayable | ERC-20 → native |

Argument order is identical across modes: output asset (native-in only), input amount, output amount, `quoteId`,
`deadline`, `recipient`, `signature`, `auxiliaryData`.

`auxiliaryData` is opaque to the pool and emitted in `SwapExecuted` for off-chain correlation.

## Deposit and withdrawal entry points

| Selector     | Function                                                                     | Signed quote                   |
| ------------ | ---------------------------------------------------------------------------- | ------------------------------ |
| `0xcdee6b48` | `depositPortfolio(uint256[],uint256,uint256,bytes32,uint256,bytes)`          | `PortfolioDeposit`             |
| `0x0e82dc83` | `depositSingleAsset(address,uint256,uint256,uint256,bytes32,uint256,bytes)`  | `SingleAssetDeposit`           |
| `0xfa059f3d` | `withdrawSingleAsset(address,uint256,address,uint256,bytes32,uint256,bytes)` | `SingleAssetWithdrawal`        |
| `0x50589f51` | `withdrawPortfolio(uint256)`                                                 | none (caller burns own shares) |

`depositPortfolio` amounts are ordered by onchain `assetAt(index)`; omitted assets must be zero. `withdrawSingleAsset`
requires `msg.sender == investor`.

## Integration views

| Selector     | Function                    | Role                                           |
| ------------ | --------------------------- | ---------------------------------------------- |
| `0xd0e15ba4` | `QUOTE_SIGNER()`            | Address signatures are verified against        |
| `0x1b3f8c5e` | `WRAPPED_NATIVE_TOKEN()`    | Wrapped native token for native legs           |
| `0x03ea8003` | `usedQuoteIds(bytes32)`     | Replay consumption flag                        |
| `0x9be918e6` | `isSupportedAsset(address)` | Asset allowlist membership                     |
| `0x7102ae2a` | `quoteDomainSeparator()`    | EIP-712 domain separator                       |
| `0x5089331d` | `recordedBalance(address)`  | Internally recorded asset balance              |
| `0xebb5bd60` | `portfolioState()`          | Recorded balances, asset list, total LP supply |
| `0xeafe7a74` | `assetCount()`              | Number of supported assets                     |
| `0xaa9239f5` | `assetAt(uint256)`          | Supported asset by index                       |
| `0x3f2306ab` | `isTradingPaused()`         | Trading pause flag (`SetwiseRebalancingPool`)  |

## EIP-712 domain

```text
name    = "SetwisePool"
version = "2.0.0"
chainId = <chain id>
verifyingContract = <pool proxy address>
```

Read the live separator from `quoteDomainSeparator()` rather than recomputing it off-chain.

## EIP-712 message types

### SwapQuote

```text
SwapQuote(address payer,address inputAsset,address outputAsset,uint256 inputAmount,uint256 outputAmount,bytes32 quoteId,uint256 deadline,address recipient)
```

- Typehash: `0x05f457dcd915199b3c456f83a601d28b8a9c57b952c20f6b13c56eec1b203c13`
- `payer` must equal `msg.sender` at execution. When the Setwise Router executes, `payer` is the router address.
- `recipient` receives output tokens or native currency.

### PortfolioDeposit

```text
PortfolioDeposit(address investor,uint256[] depositAmounts,uint256 lockDays,uint256 shares,bytes32 quoteId,uint256 deadline)
```

- Typehash: `0x90eff7950a18e9b42082d19a739e5d8f1e23ddf3844f966c174f0d942aa9a919`
- `depositAmounts` is hashed as `keccak256(abi.encodePacked(depositAmounts))`.

### SingleAssetDeposit

```text
SingleAssetDeposit(address investor,address asset,uint256 amount,uint256 lockDays,uint256 shares,bytes32 quoteId,uint256 deadline)
```

- Typehash: `0x095d9af042f81616b461d77a774c588365a147dee1311ce4a5bb47309041ca66`

### SingleAssetWithdrawal

```text
SingleAssetWithdrawal(address investor,uint256 sharesToBurn,address asset,uint256 assetAmount,bytes32 quoteId,uint256 deadline)
```

- Typehash: `0xd130e39ea81bebd4391a6f69404b552b458c51e16eac11cf292fe2f8ebd03c4b`
- For native output, sign `WRAPPED_NATIVE_TOKEN` as `asset`; the pool unwraps before sending ETH.

## Payer, recipient, and `msg.sender`

| Operation                  | `msg.sender` role                   | Signed identity field       |
| -------------------------- | ----------------------------------- | --------------------------- |
| Swap                       | Payer; must match `SwapQuote.payer` | `recipient` receives output |
| Portfolio / single deposit | Investor; receives LP shares        | `investor` in deposit types |
| Single-asset withdrawal    | Must equal `investor`               | Assets sent to `msg.sender` |
| Proportional withdrawal    | Share burner                        | n/a                         |

The contracts use `msg.sender`, not `tx.origin`, so smart accounts and ERC-4337 bundles are supported. Asset-moving
entry points are `nonReentrant`.

## Quote IDs and replay protection

- Every signed action carries a globally unique, nonzero `bytes32 quoteId`.
- `verifyAndConsumeQuote` sets `usedQuoteIds[quoteId] = true` before settlement.
- Reusing a `quoteId` reverts with `QuoteAlreadyUsed(bytes32)`.
- A zero `quoteId` reverts with `InvalidQuoteId()`.
- Quote IDs are unordered: independent quotes may execute concurrently or out of issuance order.

`SwapExecuted` does not yet include `quoteId` onchain (see repository TODO); consumers should correlate via
`auxiliaryData` or off-chain indexes until that event field ships.

## Deadlines

### Deposits and withdrawals

`deadline` is a plain Unix timestamp. The pool requires `block.timestamp <= deadline` and reverts with
`"Setwise: Expired"` when violated.

### Swaps on `SetwisePool`

Same plain Unix timestamp check via `beforeDeadline(deadline)`.

### Swaps on `SetwiseRebalancingPool` (packed guard)

The swap `deadline` argument is a **packed word** encoding off-chain inventory anchors and a 32-bit execution timestamp:

```text
bits 255..160  uint96  offchain input balance (qX anchor)
bits 159..64   uint96  offchain output balance (qY anchor)
bits 63..48    uint16  input tolerance (ppm above offchainX → maximumX)
bits 47..32    uint16  output tolerance (ppm below offchainY → minimumY)
bits 31..0     uint32  execution deadline (Unix time)
```

Tolerance math (1e6 fixed point):

```text
maximumX = offchainX * (1e6 + rawMultX) / 1e6
minimumY = offchainY * (1e6 - rawMultY) / 1e6
```

Before updating balances the pool reads current `recordedBalance` for input and output assets and runs `checkInvariant`.
Violations revert with `RebalancingInvariantViolation()`.

The RFQ API packs this word via `packSwapDeadline`; see [`cenodev/rfq-api`](https://github.com/cenodev/rfq-api)
`src/domain/firm-quotes.ts`.

Indicative quote `validUntil` in the RFQ API is **not** this packed deadline.

## Native-token encoding

Native legs are never `address(0)` in a signed quote. Always use `WRAPPED_NATIVE_TOKEN`:

| Mode            | Entry point               | `msg.value`   | Quote input asset      | Quote output asset     |
| --------------- | ------------------------- | ------------- | ---------------------- | ---------------------- |
| ERC-20 → ERC-20 | `swapExactAssetForAsset`  | `0`           | input ERC-20           | output ERC-20          |
| native → ERC-20 | `swapExactNativeForAsset` | `inputAmount` | `WRAPPED_NATIVE_TOKEN` | output ERC-20          |
| ERC-20 → native | `swapExactAssetForNative` | `0`           | input ERC-20           | `WRAPPED_NATIVE_TOKEN` |

`swapExactNativeForAsset` reverts `InvalidNativeAmount(expected, provided)` when `msg.value` does not equal the signed
input amount.

`SwapExecuted` emits `WRAPPED_NATIVE_TOKEN` for a native leg, matching the signed quote.

## Events

| Topic                                                                | Event                                                                                                                                                        |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0xa2fe6ab887b4a569b99c1b733c36e55e75e395f7aee85044820ab8155716c9e6` | `SwapExecuted(address indexed inputAsset, address indexed outputAsset, address indexed recipient, uint256 inAmount, uint256 outAmount, bytes auxiliaryData)` |

## Errors

| Selector     | Error                                  | When                                           |
| ------------ | -------------------------------------- | ---------------------------------------------- |
| `0xe6b79916` | `QuoteAlreadyUsed(bytes32)`            | `quoteId` already consumed                     |
| `0x140dcdb5` | `InvalidQuoteId()`                     | `quoteId == 0`                                 |
| `0xcfdff0eb` | `InvalidNativeAmount(uint256,uint256)` | `msg.value` mismatch on native-in swap         |
| `0x8baa579f` | `InvalidSignature()`                   | Signature not valid for `QUOTE_SIGNER`         |
| `0x02b874a6` | `TradingPaused()`                      | Trading halted                                 |
| `0xe2f49bf6` | `RebalancingInvariantViolation()`      | Packed guard failed (`SetwiseRebalancingPool`) |

## Example: ERC-20 swap calldata shape

```text
swapExactAssetForAsset(
  inputAsset,
  outputAsset,
  inputAmount,
  outputAmount,
  quoteId,
  deadline,      // packed on SetwiseRebalancingPool
  recipient,
  signature,
  auxiliaryData
)
```

TypeScript signing helpers live in [`test/helpers/setwise.ts`](../test/helpers/setwise.ts).
