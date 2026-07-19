# BSC Testnet faucet runbook

`SetwiseMockTokenFaucet` is testnet-only. It holds transferred inventory and has no mint authority or ownership over
`MockUSDT` or any `MockBStock`. The deployed faucet address, token addresses, atomic claim amounts, initial funding
amounts, and funding transaction hashes are recorded in `deployments/bsc-testnet.json`. The app consumes the generated
`deployments/bsc-testnet.app-config.json` equivalent checked into `setwise-app/src/config/generated/`.

The current basket pays `1000000000000000000000` atomic mUSDT (1,000 tokens) and `10000000000000000000` atomic units (10
tokens) of each configured mock bStock. The cooldown is 86,400 seconds.

## Deploy against the existing testnet tokens

Configure the Hardhat `DEPLOYER_PRIVATE_KEY` variable for the token holder, then run:

```sh
bun run deploy:faucet:bsc-testnet
```

`FAUCET_FUNDING_CLAIMS` changes the initial number of funded baskets (default 500). `SETWISE_FAUCET_OWNER` can assign
operations to another owner without transferring ownership of any mock token. `SETWISE_APP_CONFIG_PATH` overrides the
generated app-manifest destination.

## Pause and resume

```sh
FAUCET_ACTION=pause bun run manage:faucet:bsc-testnet
FAUCET_ACTION=unpause bun run manage:faucet:bsc-testnet
```

Pause when any configured inventory is low, the configuration is wrong, or the faucet requires investigation.

## Top up inventory

The top-up script transfers more of every configured pre-minted token from the operator and appends every transaction
hash to the deployment manifest. It never mints assets.

```sh
FAUCET_TOP_UP_CLAIMS=250 bun run top-up:faucet:bsc-testnet
```

## Change one claim amount

Always use an integer atomic amount, verify the token address against the manifest, then refresh the app to observe the
new on-chain amount.

```sh
FAUCET_ACTION=set-amount \
TOKEN_ADDRESS=0x... \
CLAIM_AMOUNT_ATOMIC=10000000000000000000 \
bun run manage:faucet:bsc-testnet
```

For a token-list change, call `setConfiguration` with the complete non-empty token and atomic-amount arrays. The
contract rejects zero addresses, duplicates, and zero amounts. Update and regenerate the app deployment manifest in the
same operational change.

## Recover unused inventory

Pause first, verify the recipient and atomic amount, then recover only the intended token:

```sh
FAUCET_ACTION=recover \
TOKEN_ADDRESS=0x... \
RECIPIENT_ADDRESS=0x... \
RECOVERY_AMOUNT_ATOMIC=1000000000000000000 \
bun run manage:faucet:bsc-testnet
```

The per-address cooldown limits repeated claims but does not prevent Sybil wallets. Do not add seed phrases, private
keys, email, IP collection, or a privileged signing backend as a substitute for the on-chain control.
