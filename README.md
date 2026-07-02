# Setwise Contracts

Setwise is an onchain investment platform and decentralised exchange for tokenised stocks. A Setwise pool combines a
diversified portfolio, an index-style share token, and a liquidity pool. Signed external-market quotes drive trading,
while each trade moves the pool toward its target portfolio allocation.

> The contracts have not been audited for production use.

## Contracts

- `SetwisePoolBase`: portfolio shares, supported assets, deposits, withdrawals, swaps, and quote verification.
- `SetwisePool`: asset balance accounting and the standard signed-quote execution paths.
- `SetwiseRebalancingPool`: the deployable pool with packed approximate-invariant checks, ERC-2612 permits, and a
  guardian-controlled trading pause.

The portfolio share token is named `Setwise Portfolio Share` with symbol `SETWISE`.

## Main API

Calls that pull approved ERC-20 assets from the caller:

- `depositPortfolio`
- `depositSingleAsset`
- `swapExactAssetForAsset`
- `swapExactAssetForNative`

Calls that settle assets transferred to the pool before the transaction:

- `settlePortfolioDeposit`
- `settleSingleAssetDeposit`
- `settleAssetForAssetSwap`
- `settleAssetForNativeSwap`

Other portfolio operations include `withdrawPortfolio`, `withdrawSingleAsset`, `claimShares`, `portfolioState`,
`assetCount`, `assetAt`, and `isSupportedAsset`.

## Signed messages

The EIP-712 domain name is `SetwisePool`, version `1.0.0`. The quote signer must produce the Setwise message types
`SwapQuote`, `PortfolioDeposit`, `SingleAssetDeposit`, and `SingleAssetWithdrawal` defined in `SetwisePoolBase.sol`.
These schemas intentionally differ from the original Clipper schemas.

## Development

Requires [Bun](https://bun.sh/).

```sh
bun install
bun run compile
bun run test
bun run lint
```

## Deployment

Set the following environment variables:

- `SETWISE_QUOTE_SIGNER`: address authorised to sign pool quotes.
- `SETWISE_WRAPPED_NATIVE_TOKEN`: wrapped native-token contract address.
- `SETWISE_ASSETS`: comma-separated list of supported asset addresses, including the wrapped native token.

Then run:

```sh
bun run deploy:contracts --network <network>
```

## License

Project tooling is MIT licensed.
