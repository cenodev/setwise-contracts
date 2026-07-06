import { ethers, network, upgrades } from "hardhat";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const mockStocks = [
  { marketSymbol: "AAPLBUSDT", name: "Mock Apple bStock", symbol: "mbAAPL", underlying: "AAPL" },
  { marketSymbol: "NVDABUSDT", name: "Mock NVIDIA bStock", symbol: "mbNVDA", underlying: "NVDA" },
  { marketSymbol: "TSLABUSDT", name: "Mock Tesla bStock", symbol: "mbTSLA", underlying: "TSLA" },
  { marketSymbol: "AMZNBUSDT", name: "Mock Amazon bStock", symbol: "mbAMZN", underlying: "AMZN" },
];

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
  const wrappedSeed = ethers.parseUnits(process.env.MOCK_WBNB_SEED ?? "0.1", 18);
  const usdtSeed = ethers.parseUnits(process.env.MOCK_USDT_SEED ?? "100000", 18);
  const stockSeed = ethers.parseUnits(process.env.MOCK_BSTOCK_SEED ?? "100", 18);
  const initialPoolShares = ethers.parseUnits(process.env.MOCK_POOL_SHARES ?? "1000", 18);

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
    marketSymbol: string;
    name: string;
    symbol: string;
    underlying: string;
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

  if (bootstrapPool) {
    await (await wrapped.deposit({ value: wrappedSeed })).wait();
    await (await wrapped.approve(proxyAddress, wrappedSeed)).wait();
    await (await usdt.approve(proxyAddress, usdtSeed)).wait();
    for (const stock of stocks) {
      const token = stockFactory.attach(stock.address);
      await (await token.approve(proxyAddress, stockSeed)).wait();
    }

    const depositAmounts = [wrappedSeed, usdtSeed, ...stocks.map(() => stockSeed)];
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
  };

  const rfqPoolConfig = [
    {
      id: "bstocks-usdt-bsc-testnet",
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
      lpToken: { symbol: "SET-BSTOCKS-LP", decimals: 18 },
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
          weight: 5,
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
          weight: 35,
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
          weight: 15,
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
          price: { type: "binance", symbol: stock.marketSymbol, quoteCurrency: "USDT", quoteUsd: "1" },
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
