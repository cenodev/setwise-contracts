import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import type { Signer } from "ethers";
import { ethers, upgrades } from "hardhat";

import type { MockERC20, MockWrappedNative, SetwiseRebalancingPool } from "../types";
import {
  futureDeadline,
  makeQuoteId,
  packGoodUntil,
  signPortfolioDeposit,
  signSingleAssetDeposit,
  signSwapQuote,
} from "./helpers/setwise";

describe("SetwiseRebalancingPool full behavior", function () {
  async function deployFixture() {
    const [owner, quoteSigner, guardian, investor, recipient, other] = await ethers.getSigners();
    const wrappedFactory = await ethers.getContractFactory("MockWrappedNative");
    const wrapped = await wrappedFactory.deploy();
    const tokenFactory = await ethers.getContractFactory("MockERC20");
    const stock = await tokenFactory.deploy("Tokenized Stock", "STOCK");
    const secondStock = await tokenFactory.deploy("Second Stock", "STOCK2");
    const poolFactory = await ethers.getContractFactory("SetwiseRebalancingPool");
    const pool = await upgrades.deployProxy(
      poolFactory,
      [
        quoteSigner.address,
        await wrapped.getAddress(),
        [await wrapped.getAddress(), await stock.getAddress(), await secondStock.getAddress()],
      ],
      { kind: "uups" },
    );

    return { guardian, investor, other, owner, pool, quoteSigner, recipient, secondStock, stock, wrapped };
  }

  async function deployHarnessFixture() {
    const [owner, quoteSigner] = await ethers.getSigners();
    const wrappedFactory = await ethers.getContractFactory("MockWrappedNative");
    const wrapped = await wrappedFactory.deploy();
    const harnessFactory = await ethers.getContractFactory("SetwiseRebalancingPoolHarness");
    const harness = await upgrades.deployProxy(
      harnessFactory,
      [quoteSigner.address, await wrapped.getAddress(), [await wrapped.getAddress()]],
      { kind: "uups" },
    );
    return { harness, owner, quoteSigner, wrapped };
  }

  async function syncToken(pool: SetwiseRebalancingPool, token: MockERC20, owner: Signer, amount: bigint) {
    await token.mint(await pool.getAddress(), amount);
    await pool.connect(owner).addAsset(await token.getAddress());
  }

  async function syncWrapped(pool: SetwiseRebalancingPool, wrapped: MockWrappedNative, owner: Signer, amount: bigint) {
    await wrapped.connect(owner).deposit({ value: amount });
    await wrapped.connect(owner).transfer(await pool.getAddress(), amount);
    await pool.connect(owner).addAsset(await wrapped.getAddress());
  }

  async function packedQuote(offchainX: bigint, offchainY: bigint, lifetime = 3_600): Promise<bigint> {
    const deadline = await futureDeadline(lifetime);
    return packGoodUntil(offchainX, offchainY, 10_000n, 10_000n, deadline);
  }

  it("unpacks packed quotes and covers every invariant region", async function () {
    const { harness } = await loadFixture(deployHarnessFixture);
    const packed = packGoodUntil(1_000_000n, 2_000_000n, 5_000n, 10_000n, 123_456n);

    expect(await harness.exposedUnpackGoodUntil(packed)).to.deep.equal([
      1_000_000n,
      2_000_000n,
      1_005_000n,
      1_980_000n,
    ]);

    // A3: beneficial or unchanged.
    expect(await harness.exposedCheckInvariant(900n, 1_000n, 1_000n, 1_000n, 1_100n, 900n)).to.equal(true);
    // A1/B1 and C regions.
    expect(await harness.exposedCheckInvariant(1_000n, 899n, 1_000n, 1_000n, 1_100n, 900n)).to.equal(false);
    expect(await harness.exposedCheckInvariant(1_101n, 1_000n, 1_000n, 1_000n, 1_100n, 900n)).to.equal(false);
    // B3 and A2.
    expect(await harness.exposedCheckInvariant(1_050n, 1_000n, 1_000n, 1_000n, 1_100n, 900n)).to.equal(true);
    expect(await harness.exposedCheckInvariant(1_000n, 950n, 1_000n, 1_000n, 1_100n, 900n)).to.equal(true);
    // B2, on both sides of the linear boundary.
    expect(await harness.exposedCheckInvariant(1_050n, 950n, 1_000n, 1_000n, 1_100n, 900n)).to.equal(true);
    expect(await harness.exposedCheckInvariant(1_051n, 950n, 1_000n, 1_000n, 1_100n, 900n)).to.equal(false);

    await expect(harness.exposedCreateVestingDeposit(await harness.getAddress(), 0n, 1n)).to.be.revertedWith(
      "Setwise: lock period must be positive",
    );
  });

  it("manages the guardian and ignores unauthorized pause requests", async function () {
    const { guardian, investor, owner, pool } = await loadFixture(deployFixture);

    await expect(pool.connect(investor).setGuardian(guardian.address)).to.be.revertedWith(
      "Ownable: caller is not the owner",
    );
    await expect(pool.connect(owner).setGuardian(guardian.address))
      .to.emit(pool, "GuardianChanged")
      .withArgs(guardian.address);

    await pool.connect(investor).pauseTrading();
    expect(await pool.isTradingPaused()).to.equal(false);
    await pool.connect(guardian).pauseTrading();
    expect(await pool.isTradingPaused()).to.equal(true);
    await pool.connect(investor).resumeTrading();
    expect(await pool.isTradingPaused()).to.equal(true);
    await pool.connect(guardian).resumeTrading();
    expect(await pool.isTradingPaused()).to.equal(false);
  });

  it("blocks active trading while paused but permits proportional exits", async function () {
    const { guardian, investor, owner, pool, quoteSigner, stock } = await loadFixture(deployFixture);
    const poolAddress = await pool.getAddress();
    const stockAddress = await stock.getAddress();
    const deadline = await futureDeadline();
    const depositId = makeQuoteId("pause-deposit-seed");
    const depositSignature = await signSingleAssetDeposit(
      quoteSigner,
      poolAddress,
      investor.address,
      stockAddress,
      100n,
      0n,
      100n,
      depositId,
      deadline,
    );
    await stock.mint(investor.address, 101n);
    await stock.connect(investor).approve(poolAddress, 101n);
    await pool
      .connect(investor)
      .depositSingleAsset(stockAddress, 100n, 0n, 100n, depositId, deadline, depositSignature);

    await pool.connect(owner).setGuardian(guardian.address);
    await pool.connect(guardian).pauseTrading();
    const pausedId = makeQuoteId("paused-deposit");
    const pausedSignature = await signSingleAssetDeposit(
      quoteSigner,
      poolAddress,
      investor.address,
      stockAddress,
      1n,
      0n,
      1n,
      pausedId,
      deadline,
    );
    await expect(
      pool.connect(investor).depositSingleAsset(stockAddress, 1n, 0n, 1n, pausedId, deadline, pausedSignature),
    ).to.be.revertedWithCustomError(pool, "TradingPaused");
    expect(await pool.usedQuoteIds(pausedId)).to.equal(false);

    await expect(
      pool.connect(investor).depositPortfolio([], 0n, 0n, makeQuoteId("paused-portfolio"), deadline, "0x"),
    ).to.be.revertedWithCustomError(pool, "TradingPaused");
    await expect(
      pool
        .connect(investor)
        .withdrawSingleAsset(
          investor.address,
          0n,
          stockAddress,
          0n,
          makeQuoteId("paused-single-withdrawal"),
          deadline,
          "0x",
        ),
    ).to.be.revertedWithCustomError(pool, "TradingPaused");

    const packed = await packedQuote(100n, 100n);
    await expect(
      pool
        .connect(investor)
        .swapExactNativeForAsset(
          stockAddress,
          0n,
          0n,
          makeQuoteId("paused-rebalancing-native-input"),
          packed,
          investor.address,
          "0x",
          "0x",
        ),
    ).to.be.revertedWithCustomError(pool, "TradingPaused");
    await expect(
      pool
        .connect(investor)
        .swapExactAssetForNative(
          stockAddress,
          0n,
          0n,
          makeQuoteId("paused-rebalancing-native-output"),
          packed,
          investor.address,
          "0x",
          "0x",
        ),
    ).to.be.revertedWithCustomError(pool, "TradingPaused");
    await expect(
      pool
        .connect(investor)
        .swapExactAssetForAsset(
          stockAddress,
          stockAddress,
          0n,
          0n,
          makeQuoteId("paused-rebalancing-assets"),
          packed,
          investor.address,
          "0x",
          "0x",
        ),
    ).to.be.revertedWithCustomError(pool, "TradingPaused");

    await pool.connect(investor).withdrawPortfolio(25n);
    expect(await pool.balanceOf(investor.address)).to.equal(75n);
    expect(await stock.balanceOf(investor.address)).to.equal(26n);
    expect(await pool.recordedBalance(stockAddress)).to.equal(75n);
  });

  it("supports ERC-2612 permits for portfolio shares", async function () {
    const { investor, other, pool, quoteSigner, stock } = await loadFixture(deployFixture);
    const poolAddress = await pool.getAddress();
    const stockAddress = await stock.getAddress();
    const quoteDeadline = await futureDeadline();
    const depositId = makeQuoteId("permit-share-deposit");
    const depositSignature = await signSingleAssetDeposit(
      quoteSigner,
      poolAddress,
      investor.address,
      stockAddress,
      10n,
      0n,
      10n,
      depositId,
      quoteDeadline,
    );
    await stock.mint(investor.address, 10n);
    await stock.connect(investor).approve(poolAddress, 10n);
    await pool
      .connect(investor)
      .depositSingleAsset(stockAddress, 10n, 0n, 10n, depositId, quoteDeadline, depositSignature);

    const permitDeadline = await futureDeadline();
    const network = await ethers.provider.getNetwork();
    const signature = ethers.Signature.from(
      await investor.signTypedData(
        {
          chainId: network.chainId,
          name: "Setwise Portfolio Share",
          verifyingContract: poolAddress,
          version: "1",
        },
        {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        { deadline: permitDeadline, nonce: 0n, owner: investor.address, spender: other.address, value: 7n },
      ),
    );

    await pool
      .connect(other)
      .permit(investor.address, other.address, 7n, permitDeadline, signature.v, signature.r, signature.s);
    expect(await pool.allowance(investor.address, other.address)).to.equal(7n);
    expect(await pool.nonces(investor.address)).to.equal(1n);
  });

  it("executes an invariant-checked ERC-20 to ERC-20 swap", async function () {
    const { investor, owner, pool, quoteSigner, recipient, secondStock, stock } = await loadFixture(deployFixture);
    const poolAddress = await pool.getAddress();
    const inputAddress = await stock.getAddress();
    const outputAddress = await secondStock.getAddress();
    await syncToken(pool, secondStock, owner, 200n);
    await stock.mint(investor.address, 50n);
    await stock.connect(investor).approve(poolAddress, 50n);
    const packed = await packedQuote(0n, 200n);
    const quoteId = makeQuoteId("rebalancing-asset-for-asset");
    const signature = await signSwapQuote(
      quoteSigner,
      poolAddress,
      investor.address,
      inputAddress,
      outputAddress,
      50n,
      20n,
      quoteId,
      packed,
      recipient.address,
    );

    await pool
      .connect(investor)
      .swapExactAssetForAsset(
        inputAddress,
        outputAddress,
        50n,
        20n,
        quoteId,
        packed,
        recipient.address,
        signature,
        "0x01",
      );
    expect(await pool.recordedBalance(inputAddress)).to.equal(50n);
    expect(await pool.recordedBalance(outputAddress)).to.equal(180n);
    expect(await secondStock.balanceOf(recipient.address)).to.equal(20n);
  });

  it("executes invariant-checked native input and native output swaps", async function () {
    const { investor, owner, pool, quoteSigner, recipient, stock, wrapped } = await loadFixture(deployFixture);
    const poolAddress = await pool.getAddress();
    const stockAddress = await stock.getAddress();
    const wrappedAddress = await wrapped.getAddress();
    await syncToken(pool, stock, owner, 200n);

    const nativePacked = await packedQuote(0n, 200n);
    const nativeId = makeQuoteId("rebalancing-native-input");
    const nativeSignature = await signSwapQuote(
      quoteSigner,
      poolAddress,
      investor.address,
      wrappedAddress,
      stockAddress,
      30n,
      12n,
      nativeId,
      nativePacked,
      recipient.address,
    );
    await pool
      .connect(investor)
      .swapExactNativeForAsset(
        stockAddress,
        30n,
        12n,
        nativeId,
        nativePacked,
        recipient.address,
        nativeSignature,
        "0x",
        { value: 30n },
      );
    expect(await pool.recordedBalance(wrappedAddress)).to.equal(30n);
    expect(await pool.recordedBalance(stockAddress)).to.equal(188n);

    await syncWrapped(pool, wrapped, owner, 100n);
    await stock.mint(investor.address, 20n);
    await stock.connect(investor).approve(poolAddress, 20n);
    const outputPacked = await packedQuote(188n, 130n);
    const outputId = makeQuoteId("rebalancing-native-output");
    const outputSignature = await signSwapQuote(
      quoteSigner,
      poolAddress,
      investor.address,
      stockAddress,
      wrappedAddress,
      20n,
      10n,
      outputId,
      outputPacked,
      recipient.address,
    );
    await expect(() =>
      pool
        .connect(investor)
        .swapExactAssetForNative(
          stockAddress,
          20n,
          10n,
          outputId,
          outputPacked,
          recipient.address,
          outputSignature,
          "0x02",
        ),
    ).to.changeEtherBalance(recipient, 10n);
    expect(await pool.recordedBalance(stockAddress)).to.equal(208n);
    expect(await pool.recordedBalance(wrappedAddress)).to.equal(120n);
  });

  it("rejects wrong native value, expired packed quotes, and invariant violations atomically", async function () {
    const { investor, owner, pool, quoteSigner, recipient, secondStock, stock, wrapped } =
      await loadFixture(deployFixture);
    const poolAddress = await pool.getAddress();
    const inputAddress = await stock.getAddress();
    const outputAddress = await secondStock.getAddress();
    const wrappedAddress = await wrapped.getAddress();
    await syncToken(pool, stock, owner, 20n);
    await syncToken(pool, secondStock, owner, 100n);
    await stock.mint(investor.address, 10n);
    await stock.connect(investor).approve(poolAddress, 10n);

    await expect(
      pool
        .connect(investor)
        .swapExactNativeForAsset(
          outputAddress,
          2n,
          1n,
          makeQuoteId("rebalancing-wrong-native"),
          await packedQuote(0n, 100n),
          recipient.address,
          "0x",
          "0x",
          { value: 1n },
        ),
    )
      .to.be.revertedWithCustomError(pool, "InvalidNativeAmount")
      .withArgs(2n, 1n);

    const expiredTimestamp = BigInt((await time.latest()) - 1);
    const expiredPacked = packGoodUntil(20n, 100n, 10_000n, 10_000n, expiredTimestamp);
    const expiredId = makeQuoteId("rebalancing-expired");
    const expiredSignature = await signSwapQuote(
      quoteSigner,
      poolAddress,
      investor.address,
      inputAddress,
      outputAddress,
      5n,
      5n,
      expiredId,
      expiredPacked,
      recipient.address,
    );
    await expect(
      pool
        .connect(investor)
        .swapExactAssetForAsset(
          inputAddress,
          outputAddress,
          5n,
          5n,
          expiredId,
          expiredPacked,
          recipient.address,
          expiredSignature,
          "0x",
        ),
    ).to.be.revertedWith("Setwise: Expired");
    expect(await pool.usedQuoteIds(expiredId)).to.equal(false);

    const invalidPacked = await packedQuote(10n, 100n);
    const invalidId = makeQuoteId("rebalancing-invalid-invariant");
    const invalidSignature = await signSwapQuote(
      quoteSigner,
      poolAddress,
      investor.address,
      inputAddress,
      outputAddress,
      5n,
      5n,
      invalidId,
      invalidPacked,
      recipient.address,
    );
    await expect(
      pool
        .connect(investor)
        .swapExactAssetForAsset(
          inputAddress,
          outputAddress,
          5n,
          5n,
          invalidId,
          invalidPacked,
          recipient.address,
          invalidSignature,
          "0x",
        ),
    ).to.be.revertedWithCustomError(pool, "RebalancingInvariantViolation");
    expect(await pool.usedQuoteIds(invalidId)).to.equal(false);
    expect(await stock.balanceOf(investor.address)).to.equal(10n);
    expect(await pool.recordedBalance(inputAddress)).to.equal(20n);
    expect(await pool.recordedBalance(wrappedAddress)).to.equal(0n);
  });

  it("rejects reentry into every overridden rebalancing swap", async function () {
    const [, quoteSigner, investor] = await ethers.getSigners();
    const tokenFactory = await ethers.getContractFactory("MockReentrantToken");
    const tokens = [
      await tokenFactory.deploy("RR0"),
      await tokenFactory.deploy("RR1"),
      await tokenFactory.deploy("RR2"),
    ];
    const addresses = await Promise.all(tokens.map((token) => token.getAddress()));
    const poolFactory = await ethers.getContractFactory("SetwiseRebalancingPool");
    const pool = await upgrades.deployProxy(poolFactory, [quoteSigner.address, addresses[0], addresses], {
      kind: "uups",
    });
    const poolAddress = await pool.getAddress();
    const callbackData = [
      pool.interface.encodeFunctionData("swapExactNativeForAsset", [
        addresses[0],
        0n,
        0n,
        ethers.ZeroHash,
        0n,
        investor.address,
        "0x",
        "0x",
      ]),
      pool.interface.encodeFunctionData("swapExactAssetForNative", [
        addresses[0],
        0n,
        0n,
        ethers.ZeroHash,
        0n,
        investor.address,
        "0x",
        "0x",
      ]),
      pool.interface.encodeFunctionData("swapExactAssetForAsset", [
        addresses[0],
        addresses[1],
        0n,
        0n,
        ethers.ZeroHash,
        0n,
        investor.address,
        "0x",
        "0x",
      ]),
    ];
    for (let i = 0; i < tokens.length; i++) {
      await tokens[i].mint(investor.address, 1n);
      await tokens[i].connect(investor).approve(poolAddress, 1n);
      await tokens[i].configureCallback(poolAddress, callbackData[i]);
    }

    const deadline = await futureDeadline();

    // One valid inherited deposit holds the guard while the malicious token
    // attempts each overridden swap on subsequent transfers.
    const portfolioId = makeQuoteId("rebalancing-reentry-portfolio");
    const portfolioSignature = await signPortfolioDeposit(
      quoteSigner,
      poolAddress,
      investor.address,
      [1n, 1n, 1n],
      0n,
      3n,
      portfolioId,
      deadline,
    );
    await pool.connect(investor).depositPortfolio([1n, 1n, 1n], 0n, 3n, portfolioId, deadline, portfolioSignature);
    expect(await pool.balanceOf(investor.address)).to.equal(3n);
  });
});
