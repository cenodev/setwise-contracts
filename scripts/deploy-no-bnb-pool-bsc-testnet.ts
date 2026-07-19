import { ethers, network, upgrades } from "hardhat";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { BscTestnetDeployment } from "./faucet-config";

type StockDeployment = BscTestnetDeployment["mockBStocks"][number] & {
  fixedPriceUsd?: string;
  marketSymbol: string;
  weight: number;
};

type PoolConfig = {
  id: string;
  poolAddress: string;
  assets: Array<{ id: string; symbol: string; weight: number; [key: string]: unknown }>;
  [key: string]: unknown;
};

type SourceDeployment = Omit<BscTestnetDeployment, "mockBStocks"> & {
  mockBStocks: StockDeployment[];
  network: string;
  seedDetails?: {
    pricesUsd?: Record<string, string>;
  };
};

const poolId = "bstock-ai-no-bnb-bsc-testnet";
const usdtWeight = 40;

function parseTokenAmount(amount: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Invalid bootstrap token amount: ${amount}`);
  }
  return ethers.parseUnits(amount.toFixed(18), 18);
}

function formatNumber(value: number, decimals = 8): string {
  return value.toFixed(decimals).replace(/\.?0+$/, "");
}

async function fetchBinanceMidUsd(symbol: string): Promise<number> {
  const baseUrl = process.env.BINANCE_API_BASE_URL ?? "https://api.binance.com";
  const url = new URL("/api/v3/depth", baseUrl);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("limit", "5");

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch Binance depth for ${symbol}: ${response.status} ${response.statusText}`);
  }

  const depth = (await response.json()) as { asks?: Array<[string, string]>; bids?: Array<[string, string]> };
  const bid = Number(depth.bids?.[0]?.[0]);
  const ask = Number(depth.asks?.[0]?.[0]);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) {
    throw new Error(`Binance depth for ${symbol} did not include a usable best bid/ask`);
  }
  return (bid + ask) / 2;
}

async function main(): Promise<void> {
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== 97n) {
    throw new Error(`This script is restricted to BSC Testnet (chain ID 97); connected to ${chainId}`);
  }

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("Configure DEPLOYER_PRIVATE_KEY before deploying");

  const outputDirectory = path.join(process.cwd(), "deployments");
  const sourceDeploymentPath = path.join(outputDirectory, `${network.name}.json`);
  const sourceConfigPath = path.join(outputDirectory, `${network.name}.rfq-pool-config.json`);
  const sourceDeployment = JSON.parse(await readFile(sourceDeploymentPath, "utf8")) as SourceDeployment;
  const sourceConfigs = JSON.parse(await readFile(sourceConfigPath, "utf8")) as PoolConfig[];
  const sourceConfig = sourceConfigs.find(({ id }) => id === "bstock-ai-bsc-testnet");

  if (sourceDeployment.chainId !== 97) {
    throw new Error(`Source manifest is for chain ${sourceDeployment.chainId}, expected 97`);
  }
  if (!sourceConfig) throw new Error("Source RFQ configuration does not contain the BStock AI testnet pool");
  if (sourceDeployment.mockBStocks.some(({ weight }) => !Number.isFinite(weight) || weight <= 0)) {
    throw new Error("Every source mock bStock must have a positive target weight");
  }

  const deployerAddress = await deployer.getAddress();
  const quoteSigner = process.env.SETWISE_QUOTE_SIGNER ?? deployerAddress;
  const poolOwner = process.env.SETWISE_OWNER ?? deployerAddress;
  const bootstrapNotionalUsd = Number(process.env.MOCK_POOL_NOTIONAL_USD ?? "100");
  const initialPoolShares = ethers.parseUnits(process.env.MOCK_POOL_SHARES ?? "1000", 18);
  const bootstrapPool = process.env.BOOTSTRAP_POOL !== "false";

  if (!Number.isFinite(bootstrapNotionalUsd) || bootstrapNotionalUsd <= 0) {
    throw new Error("MOCK_POOL_NOTIONAL_USD must be a positive number");
  }
  if (bootstrapPool && quoteSigner.toLowerCase() !== deployerAddress.toLowerCase()) {
    throw new Error(
      "Bootstrap deposits require SETWISE_QUOTE_SIGNER to be the deployer; set BOOTSTRAP_POOL=false to skip",
    );
  }

  const supportedAssets = [sourceDeployment.mockUSDT, ...sourceDeployment.mockBStocks.map(({ address }) => address)];
  const poolFactory = await ethers.getContractFactory("SetwiseRebalancingPool");
  const pool = await upgrades.deployProxy(
    poolFactory,
    [quoteSigner, sourceDeployment.mockWrappedNative, supportedAssets],
    { kind: "uups" },
  );
  await pool.waitForDeployment();

  const proxyAddress = await pool.getAddress();
  const implementationAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);
  let seedDetails: null | {
    targetNotionalUsd: string;
    pricesUsd: Record<string, string>;
    depositAmounts: Record<string, string>;
  } = null;

  if (bootstrapPool) {
    const totalWeight = usdtWeight + sourceDeployment.mockBStocks.reduce((sum, stock) => sum + stock.weight, 0);
    if (totalWeight !== 100) throw new Error(`No-BNB target weights sum to ${totalWeight}, expected 100`);
    const targetUsd = (weight: number) => (bootstrapNotionalUsd * weight) / totalWeight;
    const pricesUsd: Record<string, string> = { USDT: "1" };
    const depositAmountsBySymbol: Record<string, string> = {};
    const usdtSeed = parseTokenAmount(targetUsd(usdtWeight));
    depositAmountsBySymbol.USDT = ethers.formatUnits(usdtSeed, 18);

    const stockSeeds: bigint[] = [];
    for (const stock of sourceDeployment.mockBStocks) {
      const priceUsd = stock.fixedPriceUsd ? Number(stock.fixedPriceUsd) : await fetchBinanceMidUsd(stock.marketSymbol);
      pricesUsd[`${stock.underlying}B`] = formatNumber(priceUsd);
      const seed = parseTokenAmount(targetUsd(stock.weight) / priceUsd);
      stockSeeds.push(seed);
      depositAmountsBySymbol[`${stock.underlying}B`] = ethers.formatUnits(seed, 18);
    }

    seedDetails = {
      targetNotionalUsd: formatNumber(bootstrapNotionalUsd, 2),
      pricesUsd,
      depositAmounts: depositAmountsBySymbol,
    };

    const usdt = await ethers.getContractAt("IERC20", sourceDeployment.mockUSDT, deployer);
    await (await usdt.approve(proxyAddress, usdtSeed)).wait();
    for (const [index, stock] of sourceDeployment.mockBStocks.entries()) {
      const token = await ethers.getContractAt("IERC20", stock.address, deployer);
      await (await token.approve(proxyAddress, stockSeeds[index]!)).wait();
    }

    const depositAmounts = [usdtSeed, ...stockSeeds];
    const latestBlock = await ethers.provider.getBlock("latest");
    const deadline = BigInt(latestBlock!.timestamp + 3_600);
    const quoteId = ethers.id(`setwise-bsc-testnet-no-bnb-bootstrap:${proxyAddress}`);
    const signature = await deployer.signTypedData(
      {
        chainId,
        name: "SetwisePool",
        verifyingContract: proxyAddress,
        version: "2.0.0",
      },
      {
        PortfolioDeposit: [
          { name: "investor", type: "address" },
          { name: "depositAmounts", type: "uint256[]" },
          { name: "lockDays", type: "uint256" },
          { name: "shares", type: "uint256" },
          { name: "quoteId", type: "bytes32" },
          { name: "deadline", type: "uint256" },
        ],
      },
      {
        deadline,
        depositAmounts,
        investor: deployerAddress,
        lockDays: 0n,
        quoteId,
        shares: initialPoolShares,
      },
    );
    await (await pool.depositPortfolio(depositAmounts, 0n, initialPoolShares, quoteId, deadline, signature)).wait();
  }

  if (poolOwner.toLowerCase() !== deployerAddress.toLowerCase()) {
    await (await pool.transferOwnership(poolOwner)).wait();
  }

  const deployment = {
    chainId: Number(chainId),
    deployedAt: new Date().toISOString(),
    deployer: deployerAddress,
    mockBStocks: sourceDeployment.mockBStocks,
    mockUSDT: sourceDeployment.mockUSDT,
    mockWrappedNative: sourceDeployment.mockWrappedNative,
    network: network.name,
    poolImplementation: implementationAddress,
    poolOwner,
    poolProxy: proxyAddress,
    quoteSigner,
    seeded: bootstrapPool,
    seedDetails,
    sourceDeployment: path.basename(sourceDeploymentPath),
  };

  const noBnbConfig: PoolConfig = {
    ...sourceConfig,
    id: poolId,
    poolAddress: proxyAddress,
    assets: sourceConfig.assets
      .filter(({ id }) => id !== "WBNB-BSC-TESTNET")
      .map((asset) => (asset.id === "USDT-BSC-TESTNET" ? { ...asset, weight: usdtWeight } : asset)),
  };
  if (noBnbConfig.assets.some(({ id }) => id === "WBNB-BSC-TESTNET")) {
    throw new Error("Generated no-BNB RFQ configuration still contains WBNB");
  }

  const deploymentPath = path.join(outputDirectory, `${network.name}.no-bnb.json`);
  const configPath = path.join(outputDirectory, `${network.name}.no-bnb.rfq-pool-config.json`);
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`, "utf8"),
    writeFile(configPath, `${JSON.stringify([noBnbConfig], null, 2)}\n`, "utf8"),
  ]);

  console.log(JSON.stringify(deployment, null, 2));
  console.log(`No-BNB deployment manifest written to ${deploymentPath}`);
  console.log(`No-BNB RFQ API configuration written to ${configPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
