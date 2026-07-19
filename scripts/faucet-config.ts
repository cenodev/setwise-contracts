import type { Signer } from "ethers";
import { ethers, network } from "hardhat";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const faucetCooldownSeconds = 86_400n;

// Atomic 18-decimal amounts. One basket covers many minimum-notional swaps and
// a representative portfolio deposit without using symbols or floating point.
export const faucetClaimAmounts = {
  mUSDT: 1_000_000_000_000_000_000_000n,
  mbSPCX: 10_000_000_000_000_000_000n,
  mbSNDK: 10_000_000_000_000_000_000n,
  mbPLTR: 10_000_000_000_000_000_000n,
  mbQCOM: 10_000_000_000_000_000_000n,
  mbDRAM: 10_000_000_000_000_000_000n,
  mbGOOGL: 10_000_000_000_000_000_000n,
  mbMU: 10_000_000_000_000_000_000n,
  mbNVDA: 10_000_000_000_000_000_000n,
} as const;

export type MockStockDeployment = {
  address: string;
  name: string;
  symbol: string;
  underlying: string;
};

export type FaucetAssetInput = {
  address: string;
  decimals: number;
  name: string;
  symbol: keyof typeof faucetClaimAmounts;
};

export type FaucetDeployment = {
  address: string;
  cooldownSeconds: string;
  owner: string;
  tokens: Array<
    FaucetAssetInput & {
      claimAmountAtomic: string;
      fundedAmountAtomic: string;
      fundingTransaction: string;
    }
  >;
};

export type BscTestnetDeployment = {
  chainId: number;
  deployer?: string;
  mockBStocks: MockStockDeployment[];
  mockUSDT: string;
  mockWrappedNative: string;
  faucet?: FaucetDeployment;
  topUps?: Array<{
    at: string;
    claims: string;
    transactions: Array<{ token: string; amountAtomic: string; hash: string }>;
  }>;
  [key: string]: unknown;
};

export function configuredFaucetAssets(
  deployment: Pick<BscTestnetDeployment, "mockBStocks" | "mockUSDT">,
): FaucetAssetInput[] {
  return [
    { address: deployment.mockUSDT, decimals: 18, name: "Mock Tether USD", symbol: "mUSDT" },
    ...deployment.mockBStocks.map(({ address, name, symbol }) => {
      if (!(symbol in faucetClaimAmounts) || symbol === "mUSDT") {
        throw new Error(`No faucet claim amount is configured for ${symbol}`);
      }
      return { address, decimals: 18, name, symbol: symbol as keyof typeof faucetClaimAmounts };
    }),
  ];
}

export function parsePositiveInteger(value: string | undefined, fallback: bigint, label: string): bigint {
  const candidate = value?.trim() || fallback.toString();
  if (!/^\d+$/.test(candidate) || BigInt(candidate) <= 0n) {
    throw new Error(`${label} must be a positive integer`);
  }
  return BigInt(candidate);
}

export async function deployAndFundFaucet(
  deployer: Signer,
  assets: FaucetAssetInput[],
  owner: string,
  fundingClaims: bigint,
): Promise<FaucetDeployment> {
  const tokens = assets.map(({ address }) => address);
  const amounts = assets.map(({ symbol }) => faucetClaimAmounts[symbol]);
  const factory = await ethers.getContractFactory("SetwiseMockTokenFaucet", deployer);
  const faucet = await factory.deploy(tokens, amounts, faucetCooldownSeconds, owner);
  await faucet.waitForDeployment();
  const faucetAddress = await faucet.getAddress();

  const fundedTokens: FaucetDeployment["tokens"] = [];
  for (const asset of assets) {
    const claimAmount = faucetClaimAmounts[asset.symbol];
    const fundedAmount = claimAmount * fundingClaims;
    const token = await ethers.getContractAt("IERC20", asset.address, deployer);
    const transaction = await token.transfer(faucetAddress, fundedAmount);
    await transaction.wait();
    fundedTokens.push({
      ...asset,
      claimAmountAtomic: claimAmount.toString(),
      fundedAmountAtomic: fundedAmount.toString(),
      fundingTransaction: transaction.hash,
    });
  }

  return {
    address: faucetAddress,
    cooldownSeconds: faucetCooldownSeconds.toString(),
    owner,
    tokens: fundedTokens,
  };
}

export function appDeploymentConfig(deployment: BscTestnetDeployment) {
  if (!deployment.faucet) throw new Error("Deployment does not contain a faucet");
  return {
    chainId: deployment.chainId,
    faucet: {
      address: deployment.faucet.address,
      cooldownSeconds: deployment.faucet.cooldownSeconds,
    },
    tokens: deployment.faucet.tokens.map(({ address, decimals, name, symbol }) => ({
      address,
      decimals,
      name,
      symbol,
    })),
    wrappedNative: {
      address: deployment.mockWrappedNative,
      decimals: 18,
      name: "Mock Wrapped BNB",
      symbol: "mWBNB",
    },
    testBnbFaucetUrl: "https://docs.bnbchain.org/bnb-smart-chain/developers/faucet/",
  };
}

export async function writeDeploymentOutputs(deployment: BscTestnetDeployment, deploymentPath: string): Promise<void> {
  const appConfig = appDeploymentConfig(deployment);
  const outputDirectory = path.dirname(deploymentPath);
  const localAppConfigPath = path.join(outputDirectory, `${network.name}.app-config.json`);
  const siblingAppConfigPath = process.env.SETWISE_APP_CONFIG_PATH
    ? path.resolve(process.env.SETWISE_APP_CONFIG_PATH)
    : path.resolve(process.cwd(), "../setwise-app/src/config/generated/bsc-testnet.json");

  await mkdir(outputDirectory, { recursive: true });
  await mkdir(path.dirname(siblingAppConfigPath), { recursive: true });
  await Promise.all([
    writeFile(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`, "utf8"),
    writeFile(localAppConfigPath, `${JSON.stringify(appConfig, null, 2)}\n`, "utf8"),
    writeFile(siblingAppConfigPath, `${JSON.stringify(appConfig, null, 2)}\n`, "utf8"),
  ]);
}
