import { expect } from "chai";
import type { Signer } from "ethers";
import { ethers, upgrades } from "hardhat";

const singleAssetDepositTypes = {
  SingleAssetDeposit: [
    { name: "investor", type: "address" },
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "lockDays", type: "uint256" },
    { name: "shares", type: "uint256" },
    { name: "quoteId", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
};

const swapQuoteTypes = {
  SwapQuote: [
    { name: "payer", type: "address" },
    { name: "inputAsset", type: "address" },
    { name: "outputAsset", type: "address" },
    { name: "inputAmount", type: "uint256" },
    { name: "outputAmount", type: "uint256" },
    { name: "quoteId", type: "bytes32" },
    { name: "deadline", type: "uint256" },
    { name: "recipient", type: "address" },
  ],
};

describe("SetwiseRebalancingPool", function () {
  async function deployFixture() {
    const [owner, quoteSigner, guardian, investor, secondInvestor] = await ethers.getSigners();
    const mockFactory = await ethers.getContractFactory("MockERC20");
    const wrappedNative = await mockFactory.deploy("Wrapped Native", "WNATIVE");
    const stock = await mockFactory.deploy("Tokenized Stock", "STOCK");

    const poolFactory = await ethers.getContractFactory("SetwiseRebalancingPool");
    const pool = await upgrades.deployProxy(
      poolFactory,
      [
        quoteSigner.address,
        await wrappedNative.getAddress(),
        [await wrappedNative.getAddress(), await stock.getAddress()],
      ],
      { kind: "uups" },
    );

    return { guardian, investor, owner, pool, quoteSigner, secondInvestor, stock, wrappedNative };
  }

  async function deadline(): Promise<bigint> {
    const block = await ethers.provider.getBlock("latest");
    return BigInt(block!.timestamp + 3_600);
  }

  async function signSingleAssetDeposit(
    signer: Signer,
    poolAddress: string,
    investor: string,
    asset: string,
    amount: bigint,
    lockDays: bigint,
    shares: bigint,
    quoteId: string,
    quoteDeadline: bigint,
  ): Promise<string> {
    const network = await ethers.provider.getNetwork();
    return signer.signTypedData(
      {
        chainId: network.chainId,
        name: "SetwisePool",
        verifyingContract: poolAddress,
        version: "2.0.0",
      },
      singleAssetDepositTypes,
      { amount, asset, quoteId, deadline: quoteDeadline, investor, lockDays, shares },
    );
  }

  async function signSwapQuote(
    signer: Signer,
    poolAddress: string,
    payer: string,
    inputAsset: string,
    outputAsset: string,
    inputAmount: bigint,
    outputAmount: bigint,
    quoteId: string,
    quoteDeadline: bigint,
    recipient: string,
  ): Promise<string> {
    const network = await ethers.provider.getNetwork();
    return signer.signTypedData(
      {
        chainId: network.chainId,
        name: "SetwisePool",
        verifyingContract: poolAddress,
        version: "2.0.0",
      },
      swapQuoteTypes,
      { quoteId, deadline: quoteDeadline, inputAmount, inputAsset, outputAmount, outputAsset, payer, recipient },
    );
  }

  it("uses Setwise portfolio branding and constructor configuration", async function () {
    const { pool, quoteSigner, wrappedNative } = await deployFixture();

    expect(await pool.name()).to.equal("Setwise Portfolio Share");
    expect(await pool.symbol()).to.equal("SETWISE");
    expect(await pool.QUOTE_SIGNER()).to.equal(quoteSigner.address);
    expect(await pool.WRAPPED_NATIVE_TOKEN()).to.equal(await wrappedNative.getAddress());
    expect(await pool.assetCount()).to.equal(2n);
  });

  it("lets the owner expand the supported portfolio", async function () {
    const { pool } = await deployFixture();
    const mockFactory = await ethers.getContractFactory("MockERC20");
    const newStock = await mockFactory.deploy("Another Stock", "NEXT");

    await pool.addAsset(await newStock.getAddress());

    expect(await pool.isSupportedAsset(await newStock.getAddress())).to.equal(true);
    expect(await pool.assetCount()).to.equal(3n);
  });

  it("lets the guardian pause and resume trading", async function () {
    const { guardian, pool } = await deployFixture();
    await pool.setGuardian(guardian.address);

    await pool.connect(guardian).pauseTrading();
    expect(await pool.isTradingPaused()).to.equal(true);

    await pool.connect(guardian).resumeTrading();
    expect(await pool.isTradingPaused()).to.equal(false);
  });

  it("consumes a unique quote ID and rejects replay", async function () {
    const { investor, pool, quoteSigner, stock } = await deployFixture();
    const amount = 100n;
    const shares = 25n;
    const quoteDeadline = await deadline();
    const poolAddress = await pool.getAddress();
    const stockAddress = await stock.getAddress();
    const quoteId = ethers.id("single-deposit-replay");
    const signature = await signSingleAssetDeposit(
      quoteSigner,
      poolAddress,
      investor.address,
      stockAddress,
      amount,
      0n,
      shares,
      quoteId,
      quoteDeadline,
    );

    await stock.mint(investor.address, amount * 2n);
    await stock.connect(investor).approve(poolAddress, amount * 2n);
    await pool
      .connect(investor)
      .depositSingleAsset(stockAddress, amount, 0n, shares, quoteId, quoteDeadline, signature);

    expect(await pool.usedQuoteIds(quoteId)).to.equal(true);
    await expect(
      pool.connect(investor).depositSingleAsset(stockAddress, amount, 0n, shares, quoteId, quoteDeadline, signature),
    )
      .to.be.revertedWithCustomError(pool, "QuoteAlreadyUsed")
      .withArgs(quoteId);
  });

  it("executes independent quotes from the same wallet out of issuance order", async function () {
    const { investor, pool, quoteSigner, stock } = await deployFixture();
    const firstAmount = 40n;
    const secondAmount = 60n;
    const firstShares = 8n;
    const secondShares = 12n;
    const quoteDeadline = await deadline();
    const poolAddress = await pool.getAddress();
    const stockAddress = await stock.getAddress();
    const firstQuoteId = ethers.id("out-of-order-deposit-one");
    const secondQuoteId = ethers.id("out-of-order-deposit-two");
    const firstSignature = await signSingleAssetDeposit(
      quoteSigner,
      poolAddress,
      investor.address,
      stockAddress,
      firstAmount,
      0n,
      firstShares,
      firstQuoteId,
      quoteDeadline,
    );
    const secondSignature = await signSingleAssetDeposit(
      quoteSigner,
      poolAddress,
      investor.address,
      stockAddress,
      secondAmount,
      0n,
      secondShares,
      secondQuoteId,
      quoteDeadline,
    );

    await stock.mint(investor.address, firstAmount + secondAmount);
    await stock.connect(investor).approve(poolAddress, firstAmount + secondAmount);

    await pool
      .connect(investor)
      .depositSingleAsset(stockAddress, secondAmount, 0n, secondShares, secondQuoteId, quoteDeadline, secondSignature);
    await pool
      .connect(investor)
      .depositSingleAsset(stockAddress, firstAmount, 0n, firstShares, firstQuoteId, quoteDeadline, firstSignature);

    expect(await pool.balanceOf(investor.address)).to.equal(firstShares + secondShares);
    expect(await pool.usedQuoteIds(firstQuoteId)).to.equal(true);
    expect(await pool.usedQuoteIds(secondQuoteId)).to.equal(true);
  });

  it("rejects a zero quote ID", async function () {
    const { investor, pool, quoteSigner, stock } = await deployFixture();
    const quoteDeadline = await deadline();
    const poolAddress = await pool.getAddress();
    const stockAddress = await stock.getAddress();
    const signature = await signSingleAssetDeposit(
      quoteSigner,
      poolAddress,
      investor.address,
      stockAddress,
      1n,
      0n,
      1n,
      ethers.ZeroHash,
      quoteDeadline,
    );

    await expect(
      pool.connect(investor).depositSingleAsset(stockAddress, 1n, 0n, 1n, ethers.ZeroHash, quoteDeadline, signature),
    ).to.be.revertedWithCustomError(pool, "InvalidQuoteId");
  });

  it("accepts quotes from an ERC-1271 contract signer", async function () {
    const { investor, quoteSigner, stock, wrappedNative } = await deployFixture();
    const signerFactory = await ethers.getContractFactory("MockERC1271Signer");
    const contractSigner = await signerFactory.deploy(quoteSigner.address);
    const poolFactory = await ethers.getContractFactory("SetwiseRebalancingPool");
    const pool = await upgrades.deployProxy(
      poolFactory,
      [
        await contractSigner.getAddress(),
        await wrappedNative.getAddress(),
        [await wrappedNative.getAddress(), await stock.getAddress()],
      ],
      { kind: "uups" },
    );
    const amount = 80n;
    const shares = 20n;
    const quoteDeadline = await deadline();
    const poolAddress = await pool.getAddress();
    const stockAddress = await stock.getAddress();
    const quoteId = ethers.id("erc1271-single-deposit");
    const signature = await signSingleAssetDeposit(
      quoteSigner,
      poolAddress,
      investor.address,
      stockAddress,
      amount,
      0n,
      shares,
      quoteId,
      quoteDeadline,
    );

    await stock.mint(investor.address, amount);
    await stock.connect(investor).approve(poolAddress, amount);
    await pool
      .connect(investor)
      .depositSingleAsset(stockAddress, amount, 0n, shares, quoteId, quoteDeadline, signature);

    expect(await pool.balanceOf(investor.address)).to.equal(shares);
    expect(await pool.usedQuoteIds(quoteId)).to.equal(true);
  });

  it("binds swap quotes to the paying wallet", async function () {
    const { investor, quoteSigner, secondInvestor, stock, wrappedNative } = await deployFixture();
    const poolFactory = await ethers.getContractFactory("SetwisePool");
    const pool = await upgrades.deployProxy(
      poolFactory,
      [
        quoteSigner.address,
        await wrappedNative.getAddress(),
        [await wrappedNative.getAddress(), await stock.getAddress()],
      ],
      { kind: "uups" },
    );
    const poolAddress = await pool.getAddress();
    const stockAddress = await stock.getAddress();
    const wrappedNativeAddress = await wrappedNative.getAddress();
    const inputAmount = 10n;
    const outputAmount = 5n;
    const quoteDeadline = await deadline();
    const quoteId = ethers.id("payer-bound-swap");

    await wrappedNative.mint(poolAddress, outputAmount);
    await pool.addAsset(wrappedNativeAddress);
    await stock.mint(secondInvestor.address, inputAmount);
    await stock.connect(secondInvestor).approve(poolAddress, inputAmount);
    const signature = await signSwapQuote(
      quoteSigner,
      poolAddress,
      investor.address,
      stockAddress,
      wrappedNativeAddress,
      inputAmount,
      outputAmount,
      quoteId,
      quoteDeadline,
      investor.address,
    );

    await expect(
      pool
        .connect(secondInvestor)
        .swapExactAssetForAsset(
          stockAddress,
          wrappedNativeAddress,
          inputAmount,
          outputAmount,
          quoteId,
          quoteDeadline,
          investor.address,
          signature,
          "0x",
        ),
    ).to.be.revertedWithCustomError(pool, "InvalidSignature");
  });

  it("requires the exact signed native input amount", async function () {
    const { investor, quoteSigner, stock, wrappedNative } = await deployFixture();
    const poolFactory = await ethers.getContractFactory("SetwisePool");
    const pool = await upgrades.deployProxy(
      poolFactory,
      [
        quoteSigner.address,
        await wrappedNative.getAddress(),
        [await wrappedNative.getAddress(), await stock.getAddress()],
      ],
      { kind: "uups" },
    );
    const quoteId = ethers.id("native-input-value");
    const quoteDeadline = await deadline();

    await expect(
      pool
        .connect(investor)
        .swapExactNativeForAsset(
          await stock.getAddress(),
          10n,
          5n,
          quoteId,
          quoteDeadline,
          investor.address,
          "0x",
          "0x",
          { value: 9n },
        ),
    )
      .to.be.revertedWithCustomError(pool, "InvalidNativeAmount")
      .withArgs(10n, 9n);
  });

  it("executes two smart-account operations on the same asset in one EntryPoint bundle", async function () {
    const { investor, pool, quoteSigner, secondInvestor, stock } = await deployFixture();
    const entryPointFactory = await ethers.getContractFactory("MockEntryPoint");
    const entryPoint = await entryPointFactory.deploy();
    const accountFactory = await ethers.getContractFactory("MockSmartAccount");
    const firstAccount = await accountFactory.deploy(await entryPoint.getAddress(), investor.address);
    const secondAccount = await accountFactory.deploy(await entryPoint.getAddress(), secondInvestor.address);
    const firstAccountAddress = await firstAccount.getAddress();
    const secondAccountAddress = await secondAccount.getAddress();
    const poolAddress = await pool.getAddress();
    const stockAddress = await stock.getAddress();
    const amount = 50n;
    const shares = 10n;
    const quoteDeadline = await deadline();
    const firstQuoteId = ethers.id("smart-account-deposit-one");
    const secondQuoteId = ethers.id("smart-account-deposit-two");

    await stock.mint(firstAccountAddress, amount);
    await stock.mint(secondAccountAddress, amount);
    const approveData = stock.interface.encodeFunctionData("approve", [poolAddress, amount]);
    await firstAccount.connect(investor).execute(stockAddress, 0n, approveData);
    await secondAccount.connect(secondInvestor).execute(stockAddress, 0n, approveData);

    const firstSignature = await signSingleAssetDeposit(
      quoteSigner,
      poolAddress,
      firstAccountAddress,
      stockAddress,
      amount,
      0n,
      shares,
      firstQuoteId,
      quoteDeadline,
    );
    const secondSignature = await signSingleAssetDeposit(
      quoteSigner,
      poolAddress,
      secondAccountAddress,
      stockAddress,
      amount,
      0n,
      shares,
      secondQuoteId,
      quoteDeadline,
    );
    const firstCall = pool.interface.encodeFunctionData("depositSingleAsset", [
      stockAddress,
      amount,
      0n,
      shares,
      firstQuoteId,
      quoteDeadline,
      firstSignature,
    ]);
    const secondCall = pool.interface.encodeFunctionData("depositSingleAsset", [
      stockAddress,
      amount,
      0n,
      shares,
      secondQuoteId,
      quoteDeadline,
      secondSignature,
    ]);

    await entryPoint.handleOps([
      { account: firstAccountAddress, data: firstCall, target: poolAddress, value: 0n },
      { account: secondAccountAddress, data: secondCall, target: poolAddress, value: 0n },
    ]);

    expect(await pool.balanceOf(firstAccountAddress)).to.equal(shares);
    expect(await pool.balanceOf(secondAccountAddress)).to.equal(shares);
    expect(await pool.recordedBalance(stockAddress)).to.equal(amount * 2n);
    expect(await pool.usedQuoteIds(firstQuoteId)).to.equal(true);
    expect(await pool.usedQuoteIds(secondQuoteId)).to.equal(true);
  });
});
