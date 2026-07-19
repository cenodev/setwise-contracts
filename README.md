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
- `SetwiseMockTokenFaucet`: a pre-funded, 24-hour rate-limited basket faucet for BSC Testnet mock assets.

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
bun run coverage
bun run lint
```

## Deployment

Pools are deployed as UUPS proxies. The proxy address is the permanent integration address; implementation addresses
change during upgrades. Only the pool owner can authorize an upgrade. Use a Safe or timelock as the owner for any
production deployment.

The BSC Testnet deployment also creates and funds the non-upgradeable mock-token faucet. To add a faucet to an existing
deployment, top it up, pause it, change claim amounts, or recover inventory, follow
[`docs/FAUCET_RUNBOOK.md`](./docs/FAUCET_RUNBOOK.md).

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
# Optional; defaults to a $100 bootstrap portfolio.
export MOCK_POOL_NOTIONAL_USD=100
bun run deploy:bsc-testnet
```

The script deploys the BStock AI test portfolio, mock USDT, wrapped BNB, and a `SetwiseRebalancingPool` UUPS proxy. The
portfolio is weighted using Binance bStock order-book liquidity:

| Asset  | Target weight |
| ------ | ------------: |
| USDT   |           35% |
| SPCXB  |           18% |
| SNDKB  |            7% |
| PLTRB  |            7% |
| QCOMB  |            7% |
| DRAMB  |            6% |
| GOOGLB |            6% |
| MUB    |            5% |
| WBNB   |            5% |
| NVDAB  |            4% |

By default, the script fetches Binance best bid and ask prices and makes a signed `$100` bootstrap deposit so the RFQ
API sees nonzero inventory and LP supply. Set `MOCK_POOL_NOTIONAL_USD` to change its size, or set `BOOTSTRAP_POOL=false`
to skip it. Bootstrapping requires the deployer to be the quote signer.

Deployment addresses and bootstrap details are written to `deployments/bsc-testnet.json`. A directly consumable RFQ API
configuration is written to `deployments/bsc-testnet.rfq-pool-config.json`.

To deploy a second version of the pool that reuses the same testnet mock tokens but excludes WBNB from its supported
assets and bootstrap portfolio, run:

```sh
bun run deploy:no-bnb-pool:bsc-testnet
```

The no-BNB pool assigns the removed 5% WBNB weight to USDT and writes separate `deployments/bsc-testnet.no-bnb.json` and
`deployments/bsc-testnet.no-bnb.rfq-pool-config.json` outputs, leaving the original testnet deployment unchanged.

Mock bStocks keep ordinary raw ERC-20 balances for transfers and pool accounting. `uiMultiplier`, `scaledBalanceOf`, and
`scaledTotalSupply` model bStocks corporate-action display adjustments without rebasing those raw balances.

### Upgrades

After compiling and testing a storage-compatible implementation:

```sh
export SETWISE_PROXY_ADDRESS=<proxy-address>
bun run upgrade:bsc-testnet
```

The upgrade script validates storage compatibility before submitting the owner-authorized UUPS upgrade.

## TODO

- Add quote-signer rotation, quote cancellation, and quote IDs to execution events.
- Add validated asset removal and stricter asset onboarding checks.
- Verify deployed proxy and implementation contracts on block explorers.
- Document and test the multisig/timelock production upgrade procedure.
- Add invariant fuzzing and complete an independent security audit before using real funds.

## License

Project tooling is MIT licensed.
