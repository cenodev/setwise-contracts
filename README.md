# Setwise Contracts

Setwise is an onchain investment platform and decentralised exchange for tokenised stocks. A Setwise pool combines a
diversified portfolio, an index-style share token, and a liquidity pool. Signed external-market quotes drive trading,
while each trade moves the pool toward its target portfolio allocation.

> The contracts have not been audited for production use.

## Contracts

- `SetwisePoolBase`: portfolio shares, supported assets, deposits, withdrawals, swaps, and quote verification.
- `SetwisePool`: UUPS upgrade authorization, asset balance accounting, and standard signed-quote execution paths.
- `SetwiseRebalancingPool`: the deployable pool with packed approximate-invariant checks, ERC-2612 permits, and a
  guardian-controlled trading pause.
- `MockBStock`: a testnet BEP-20 mock with a BEP-677/EIP-8056-compatible scaled-UI multiplier.
- `MockUSDT`: an owner-mintable, 18-decimal testnet token matching BSC USDT units.
- `MockWrappedBNB`: a testnet wrapped-native token for native swap testing.

The portfolio share token is named `Setwise Portfolio Share` with symbol `SETWISE`.

## Main API

Calls that pull approved ERC-20 assets from the caller:

- `depositPortfolio`
- `depositSingleAsset`
- `swapExactAssetForAsset`
- `swapExactAssetForNative`

Other portfolio operations include `withdrawPortfolio`, `withdrawSingleAsset`, `claimShares`, `portfolioState`,
`assetCount`, `assetAt`, and `isSupportedAsset`.

Asset-moving calls are atomic: ERC-20 inputs are pulled from the caller with `transferFrom`, and native swaps require
`msg.value` to equal the signed input amount. The contracts do not support settling assets transferred to a pool in an
earlier transaction.

## Signed messages

The EIP-712 domain name is `SetwisePool`, version `2.0.0`. The quote signer must produce the Setwise message types
`SwapQuote`, `PortfolioDeposit`, `SingleAssetDeposit`, and `SingleAssetWithdrawal` defined in `SetwisePoolBase.sol`.

Every signed action includes a globally unique, nonzero `bytes32 quoteId`. A successful action marks
`usedQuoteIds(quoteId)`, so it cannot be replayed. Quote IDs are unordered: independent quotes can execute concurrently
or out of issuance order, including quotes submitted through the same router. Swap quotes also include an explicit
`payer`, preventing a different wallet from submitting another user's quote. Signatures use dynamic `bytes` and support
both EOA signers and ERC-1271 contract signers such as multisigs.

## Smart wallets and account abstraction

Setwise uses `msg.sender` as the investing or paying wallet and does not rely on `tx.origin`. Multiple smart-account
operations can therefore touch the same pool asset in one ERC-4337-style EntryPoint bundle. Asset-moving entry points
are protected against reentrancy.

Smart wallets should approve portfolio assets by executing the token's normal `approve` function, which can be batched
with a Setwise call. ERC-2612 permit remains available for EOA-held portfolio shares but is not required by any Setwise
operation. Wallets that cannot receive native currency should request wrapped-native output instead.

## Development

Requires [Bun](https://bun.sh/).

```sh
bun install
bun run compile
bun run test
bun run lint
```

## Deployment

Pools are deployed as UUPS proxies. The proxy address is the permanent integration address; implementation addresses
change during upgrades. Only the pool owner can authorize an upgrade. Use a Safe or timelock as the owner for any
production deployment.

### Existing assets

Set the following environment variables:

- `SETWISE_QUOTE_SIGNER`: address authorised to sign pool quotes.
- `SETWISE_WRAPPED_NATIVE_TOKEN`: wrapped native-token contract address.
- `SETWISE_ASSETS`: comma-separated list of supported asset addresses, including the wrapped native token.

Then run:

```sh
bun run deploy:contracts --network <network>
```

### BSC Testnet with mock bStocks

BSC Testnet uses chain ID `97`. Configure a funded testnet deployer without committing its private key:

```sh
npx hardhat vars set DEPLOYER_PRIVATE_KEY
# Optional; the official public RPC is used by default.
npx hardhat vars set BSC_TESTNET_RPC_URL

export SETWISE_QUOTE_SIGNER=<quote-signer-address>
export SETWISE_OWNER=<upgrade-owner-address>
export MOCK_BSTOCK_SUPPLY=1000000
bun run deploy:bsc-testnet
```

The script deploys mock `mbAAPL`, `mbNVDA`, `mbTSLA`, `mbAMZN`, USDT, wrapped BNB, and a `SetwiseRebalancingPool` UUPS
proxy. By default it also makes a signed bootstrap deposit so the RFQ API sees nonzero inventory and LP supply. It
writes addresses to `deployments/bsc-testnet.json` and a directly consumable RFQ API configuration to
`deployments/bsc-testnet.rfq-pool-config.json`.

Mock bStocks keep ordinary raw ERC-20 balances for transfers and pool accounting. `uiMultiplier`, `scaledBalanceOf`, and
`scaledTotalSupply` model bStocks corporate-action display adjustments without rebasing those raw balances.

### Upgrades

After compiling and testing a storage-compatible implementation:

```sh
export SETWISE_PROXY_ADDRESS=<proxy-address>
bun run upgrade:bsc-testnet
```

The upgrade script validates storage compatibility before submitting the owner-authorized UUPS upgrade.

## License

Project tooling is MIT licensed.
