import { ethers, network, upgrades } from "hardhat";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const wrappedNativeWeight = 5;
const usdtWeight = 35;

const mockStocks = [
  { marketSymbol: "SPCXBUSDT", name: "Mock SpaceX bStock", symbol: "mbSPCX", underlying: "SPCX", weight: 18 },
  { marketSymbol: "SNDKBUSDT", name: "Mock SanDisk bStock", symbol: "mbSNDK", underlying: "SNDK", weight: 7 },
  { marketSymbol: "PLTRBUSDT", name: "Mock Palantir bStock", symbol: "mbPLTR", underlying: "PLTR", weight: 7 },
  { marketSymbol: "QCOMBUSDT", name: "Mock Qualcomm bStock", symbol: "mbQCOM", underlying: "QCOM", weight: 7 },
  {
    marketSymbol: "DRAMBUSDT",
    name: "Mock Roundhill Memory ETF bStock",
    symbol: "mbDRAM",
    underlying: "DRAM",
    weight: 6,
  },
  { marketSymbol: "GOOGLBUSDT", name: "Mock Alphabet bStock", symbol: "mbGOOGL", underlying: "GOOGL", weight: 6 },
  { marketSymbol: "MUBUSDT", name: "Mock Micron bStock", symbol: "mbMU", underlying: "MU", weight: 5 },
  { marketSymbol: "NVDABUSDT", name: "Mock NVIDIA bStock", symbol: "mbNVDA", underlying: "NVDA", weight: 4 },
];

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

function parseTokenAmount(amount: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Invalid bootstrap token amount: ${amount}`);
  }

  return ethers.parseUnits(amount.toFixed(18), 18);
}

function formatNumber(value: number, decimals = 8): string {
  return value.toFixed(decimals).replace(/\.?0+$/, "");
}

async function main(): Promise<void> {
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== 97n) {
    throw new Error(`This script is restricted to BSC Testnet (chain ID 97); connected to ${chainId}`);
  }

  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error("Configure DEPLOYER_PRIVATE_KEY before deploying");
  }

  const deployerAddress = await deployer.getAddress();
  const quoteSigner = process.env.SETWISE_QUOTE_SIGNER ?? deployerAddress;
  const poolOwner = process.env.SETWISE_OWNER ?? deployerAddress;
  const initialSupply = ethers.parseUnits(process.env.MOCK_BSTOCK_SUPPLY ?? "1000000", 18);
  const bootstrapPool = process.env.BOOTSTRAP_POOL !== "false";
  const bootstrapNotionalUsd = Number(process.env.MOCK_POOL_NOTIONAL_USD ?? "100");
  const initialPoolShares = ethers.parseUnits(process.env.MOCK_POOL_SHARES ?? "1000", 18);

  if (!Number.isFinite(bootstrapNotionalUsd) || bootstrapNotionalUsd <= 0) {
    throw new Error("MOCK_POOL_NOTIONAL_USD must be a positive number");
  }

  if (bootstrapPool && quoteSigner.toLowerCase() !== deployerAddress.toLowerCase()) {
    throw new Error(
      "Bootstrap deposits require SETWISE_QUOTE_SIGNER to be the deployer; set BOOTSTRAP_POOL=false to skip",
    );
  }

  console.log(`Deploying to ${network.name} with ${deployerAddress}`);

  const wrappedFactory = await ethers.getContractFactory("MockWrappedBNB");
  const wrapped = await wrappedFactory.deploy();
  await wrapped.waitForDeployment();
  const wrappedAddress = await wrapped.getAddress();

  const usdtFactory = await ethers.getContractFactory("MockUSDT");
  const usdt = await usdtFactory.deploy(deployerAddress);
  await usdt.waitForDeployment();
  const usdtAddress = await usdt.getAddress();
  await (await usdt.mint(deployerAddress, initialSupply)).wait();

  const stockFactory = await ethers.getContractFactory("MockBStock");
  const stocks: Array<{
    address: string;
    fixedPriceUsd?: string;
    marketSymbol: string;
    name: string;
    symbol: string;
    underlying: string;
    weight: number;
  }> = [];
  for (const config of mockStocks) {
    const stock = await stockFactory.deploy(config.name, config.symbol, deployerAddress);
    await stock.waitForDeployment();
    await (await stock.mint(deployerAddress, initialSupply)).wait();
    stocks.push({ ...config, address: await stock.getAddress() });
  }

  const supportedAssets = [wrappedAddress, usdtAddress, ...stocks.map(({ address }) => address)];
  const poolFactory = await ethers.getContractFactory("SetwiseRebalancingPool");
  const pool = await upgrades.deployProxy(poolFactory, [quoteSigner, wrappedAddress, supportedAssets], {
    kind: "uups",
  });
  await pool.waitForDeployment();
  const proxyAddress = await pool.getAddress();
  const implementationAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);
  let bootstrapDetails: null | {
    targetNotionalUsd: string;
    pricesUsd: Record<string, string>;
    depositAmounts: Record<string, string>;
  } = null;

  if (bootstrapPool) {
    const totalWeight = wrappedNativeWeight + usdtWeight + stocks.reduce((sum, stock) => sum + stock.weight, 0);
    const targetUsd = (weight: number) => (bootstrapNotionalUsd * weight) / totalWeight;
    const pricesUsd: Record<string, string> = { USDT: "1" };
    const depositAmountsBySymbol: Record<string, string> = {};

    const wrappedPriceUsd = await fetchBinanceMidUsd("BNBUSDT");
    pricesUsd.WBNB = formatNumber(wrappedPriceUsd);
    const wrappedSeed = parseTokenAmount(targetUsd(wrappedNativeWeight) / wrappedPriceUsd);
    const usdtSeed = parseTokenAmount(targetUsd(usdtWeight));
    depositAmountsBySymbol.WBNB = ethers.formatUnits(wrappedSeed, 18);
    depositAmountsBySymbol.USDT = ethers.formatUnits(usdtSeed, 18);

    const stockSeeds: bigint[] = [];
    for (const stock of stocks) {
      const priceUsd = stock.fixedPriceUsd ? Number(stock.fixedPriceUsd) : await fetchBinanceMidUsd(stock.marketSymbol);
      pricesUsd[`${stock.underlying}B`] = formatNumber(priceUsd);
      const seed = parseTokenAmount(targetUsd(stock.weight) / priceUsd);
      stockSeeds.push(seed);
      depositAmountsBySymbol[`${stock.underlying}B`] = ethers.formatUnits(seed, 18);
    }

    bootstrapDetails = {
      targetNotionalUsd: formatNumber(bootstrapNotionalUsd, 2),
      pricesUsd,
      depositAmounts: depositAmountsBySymbol,
    };

    await (await wrapped.deposit({ value: wrappedSeed })).wait();
    await (await wrapped.approve(proxyAddress, wrappedSeed)).wait();
    await (await usdt.approve(proxyAddress, usdtSeed)).wait();
    for (const [index, stock] of stocks.entries()) {
      const token = stockFactory.attach(stock.address);
      await (await token.approve(proxyAddress, stockSeeds[index]!)).wait();
    }

    const depositAmounts = [wrappedSeed, usdtSeed, ...stockSeeds];
    const latestBlock = await ethers.provider.getBlock("latest");
    const deadline = BigInt(latestBlock!.timestamp + 3_600);
    const quoteId = ethers.id(`setwise-bsc-testnet-bootstrap:${proxyAddress}`);
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
    mockBStocks: stocks,
    mockUSDT: usdtAddress,
    mockWrappedNative: wrappedAddress,
    network: network.name,
    poolImplementation: implementationAddress,
    poolOwner,
    poolProxy: proxyAddress,
    quoteSigner,
    seeded: bootstrapPool,
    seedDetails: bootstrapDetails,
  };

  const rfqPoolConfig = [
    {
      id: "bstock-ai-bsc-testnet",
      chainId: Number(chainId),
      chainName: "BSC Testnet",
      poolAddress: proxyAddress,
      rpcUrl: "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
      contractVersion: "2.0.0",
      k: "0.5",
      feeBps: 10,
      quoteTtlSeconds: 10,
      allowedLockDays: [0, 30, 90],
      pricingPolicy: {
        minNotionalUsd: "10",
        maxNotionalUsd: "10000",
        maxMarketAgeMs: 5000,
        maxSpreadBps: 100,
        maxVenueDivergenceBps: 500,
        maxVenuePriceImpactBps: 300,
        minDexLiquidityUsd: "10000",
        reserveBps: 100,
        hedgeMarginBps: 10,
        maxInventoryPremiumBps: 0,
        requireExternalLiquidity: true,
      },
      lpToken: { symbol: "SET-BSTOCK-AI-LP", decimals: 18 },
      pairs: stocks.map((stock) => ({
        assets: ["USDT-BSC-TESTNET", `${stock.underlying}B-BSC-TESTNET`],
        feeBps: 10,
        minNotionalUsd: "10",
        maxNotionalUsd: "10000",
        enabled: true,
      })),
      assets: [
        {
          id: "WBNB-BSC-TESTNET",
          symbol: "WBNB",
          name: "Mock Wrapped BNB",
          address: wrappedAddress,
          decimals: 18,
          weight: wrappedNativeWeight,
          tokenStandard: "BEP-20",
          multiplier: { type: "fixed", value: "1" },
          price: { type: "binance", symbol: "BNBUSDT", quoteCurrency: "USDT", quoteUsd: "1" },
        },
        {
          id: "USDT-BSC-TESTNET",
          symbol: "USDT",
          name: "Mock Tether USD",
          address: usdtAddress,
          decimals: 18,
          weight: usdtWeight,
          tokenStandard: "BEP-20",
          multiplier: { type: "fixed", value: "1" },
          price: { type: "fixed", usd: "1", quoteCurrency: "USD" },
        },
        ...stocks.map((stock) => ({
          id: `${stock.underlying}B-BSC-TESTNET`,
          symbol: `${stock.underlying}B`,
          name: stock.name,
          address: stock.address,
          decimals: 18,
          weight: stock.weight,
          underlying: { symbol: stock.underlying },
          issuer: "Mock BTech Holdings Limited",
          product: "Mock Binance bStock certificate",
          tokenStandard: "BEP-8056",
          operational: {
            secondaryTrading: "available",
            primaryConversion: "unavailable",
            eligibility: "not-required",
          },
          multiplier: { type: "erc8056", decimals: 18 },
          price: stock.fixedPriceUsd
            ? { type: "fixed", usd: stock.fixedPriceUsd, quoteCurrency: "USD" }
            : { type: "binance", symbol: stock.marketSymbol, quoteCurrency: "USDT", quoteUsd: "1" },
        })),
      ],
    },
  ];

  const outputDirectory = path.join(process.cwd(), "deployments");
  const outputPath = path.join(outputDirectory, `${network.name}.json`);
  const rfqConfigPath = path.join(outputDirectory, `${network.name}.rfq-pool-config.json`);
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(deployment, null, 2)}\n`, "utf8");
  await writeFile(rfqConfigPath, `${JSON.stringify(rfqPoolConfig, null, 2)}\n`, "utf8");

  console.log(JSON.stringify(deployment, null, 2));
  console.log(`Deployment manifest written to ${outputPath}`);
  console.log(`RFQ API pool configuration written to ${rfqConfigPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
