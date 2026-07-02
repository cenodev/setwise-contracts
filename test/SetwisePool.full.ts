import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import type { Signer } from "ethers";
import { ethers } from "hardhat";

import type { MockERC20, MockWrappedNative, SetwisePool } from "../types";
import {
  futureDeadline,
  makeQuoteId,
  signPortfolioDeposit,
  signSingleAssetDeposit,
  signSwapQuote,
  signWithdrawal,
} from "./helpers/setwise";

describe("SetwisePool full behavior", function () {
  async function deployFixture() {
    const [owner, quoteSigner, investor, recipient, other] = await ethers.getSigners();
    const wrappedFactory = await ethers.getContractFactory("MockWrappedNative");
    const wrapped = await wrappedFactory.deploy();
    const tokenFactory = await ethers.getContractFactory("MockERC20");
    const stock = await tokenFactory.deploy("Tokenized Stock", "STOCK");
    const secondStock = await tokenFactory.deploy("Second Stock", "STOCK2");
    const poolFactory = await ethers.getContractFactory("SetwisePool");
    const pool = await poolFactory.deploy(quoteSigner.address, await wrapped.getAddress(), [
      await wrapped.getAddress(),
      await stock.getAddress(),
      await secondStock.getAddress(),
    ]);

    return { investor, other, owner, pool, quoteSigner, recipient, secondStock, stock, wrapped };
  }

  async function syncToken(pool: SetwisePool, token: MockERC20, owner: Signer, amount: bigint) {
    await token.mint(await pool.getAddress(), amount);
    await pool.connect(owner).addAsset(await token.getAddress());
  }

  async function syncWrapped(pool: SetwisePool, wrapped: MockWrappedNative, owner: Signer, amount: bigint) {
    await wrapped.connect(owner).deposit({ value: amount });
    await wrapped.connect(owner).transfer(await pool.getAddress(), amount);
    await pool.connect(owner).addAsset(await wrapped.getAddress());
  }

  it("reports configuration, domain, assets, balances, and accepts direct native currency", async function () {
    const { investor, owner, pool, quoteSigner, secondStock, stock, wrapped } = await loadFixture(deployFixture);
    const poolAddress = await pool.getAddress();
    const network = await ethers.provider.getNetwork();

    expect(await pool.name()).to.equal("Setwise Portfolio Share");
    expect(await pool.symbol()).to.equal("SETWISE");
    expect(await pool.isTradingPaused()).to.equal(false);
    expect(await pool.QUOTE_SIGNER()).to.equal(quoteSigner.address);
    expect(await pool.WRAPPED_NATIVE_TOKEN()).to.equal(await wrapped.getAddress());
    expect(await pool.assetCount()).to.equal(3n);
    expect(await pool.assetAt(1)).to.equal(await stock.getAddress());
    expect(await pool.isSupportedAsset(await secondStock.getAddress())).to.equal(true);
    expect(await pool.isSupportedAsset(investor.address)).to.equal(false);
    expect(await pool.quoteDomainSeparator()).to.equal(
      ethers.TypedDataEncoder.hashDomain({
        chainId: network.chainId,
        name: "SetwisePool",
        verifyingContract: poolAddress,
        version: "2.0.0",
      }),
    );

    const [balances, tokens, supply] = await pool.portfolioState();
    expect(balances).to.deep.equal([0n, 0n, 0n]);
    expect(tokens).to.deep.equal([
      await wrapped.getAddress(),
      await stock.getAddress(),
      await secondStock.getAddress(),
    ]);
    expect(supply).to.equal(0n);

    await owner.sendTransaction({ to: poolAddress, value: 17n });
    expect(await ethers.provider.getBalance(poolAddress)).to.equal(17n);
  });

  it("adds and synchronizes an asset only for the owner and rejects malformed assets", async function () {
    const { investor, owner, pool } = await loadFixture(deployFixture);
    const tokenFactory = await ethers.getContractFactory("MockERC20");
    const newStock = await tokenFactory.deploy("New Stock", "NEW");
    await newStock.mint(await pool.getAddress(), 23n);

    await expect(pool.connect(investor).addAsset(await newStock.getAddress())).to.be.revertedWith(
      "Ownable: caller is not the owner",
    );
    await pool.connect(owner).addAsset(await newStock.getAddress());
    expect(await pool.assetCount()).to.equal(4n);
    expect(await pool.recordedBalance(await newStock.getAddress())).to.equal(23n);

    await expect(pool.connect(owner).addAsset(investor.address)).to.be.revertedWithoutReason();
  });

  it("deposits a complete portfolio, including a zero allocation", async function () {
    const { investor, pool, quoteSigner, secondStock, stock, wrapped } = await loadFixture(deployFixture);
    const poolAddress = await pool.getAddress();
    const wrappedAddress = await wrapped.getAddress();
    const secondStockAddress = await secondStock.getAddress();
    const amounts = [100n, 0n, 60n];
    const shares = 40n;
    const quoteId = makeQuoteId("full-portfolio-deposit");
    const deadline = await futureDeadline();

    await wrapped.connect(investor).deposit({ value: amounts[0] });
    await secondStock.mint(investor.address, amounts[2]);
    await wrapped.connect(investor).approve(poolAddress, amounts[0]);
    await secondStock.connect(investor).approve(poolAddress, amounts[2]);
    const signature = await signPortfolioDeposit(
      quoteSigner,
      poolAddress,
      investor.address,
      amounts,
      0n,
      shares,
      quoteId,
      deadline,
    );

    await expect(pool.connect(investor).depositPortfolio(amounts, 0n, shares, quoteId, deadline, signature))
      .to.emit(pool, "PortfolioDeposited")
      .withArgs(investor.address, shares, 0n);

    expect(await pool.balanceOf(investor.address)).to.equal(shares);
    expect(await pool.recordedBalance(wrappedAddress)).to.equal(amounts[0]);
    expect(await pool.recordedBalance(await stock.getAddress())).to.equal(0n);
    expect(await pool.recordedBalance(secondStockAddress)).to.equal(amounts[2]);
  });

  it("rejects expired portfolio quotes and fee-on-transfer portfolio deposits atomically", async function () {
    const { investor, quoteSigner, wrapped } = await loadFixture(deployFixture);
    const feeFactory = await ethers.getContractFactory("MockFeeOnTransferToken");
    const feeToken = await feeFactory.deploy();
    const poolFactory = await ethers.getContractFactory("SetwisePool");
    const pool = await poolFactory.deploy(quoteSigner.address, await wrapped.getAddress(), [
      await feeToken.getAddress(),
    ]);
    const poolAddress = await pool.getAddress();
    const amount = 100n;
    const now = BigInt(await time.latest());

    const expiredId = makeQuoteId("expired-portfolio");
    const expiredSignature = await signPortfolioDeposit(
      quoteSigner,
      poolAddress,
      investor.address,
      [amount],
      0n,
      10n,
      expiredId,
      now - 1n,
    );
    await expect(
      pool.connect(investor).depositPortfolio([amount], 0n, 10n, expiredId, now - 1n, expiredSignature),
    ).to.be.revertedWith("Setwise: Expired");

    const feeId = makeQuoteId("fee-portfolio");
    const deadline = await futureDeadline();
    const feeSignature = await signPortfolioDeposit(
      quoteSigner,
      poolAddress,
      investor.address,
      [amount],
      0n,
      10n,
      feeId,
      deadline,
    );
    await feeToken.mint(investor.address, amount);
    await feeToken.connect(investor).approve(poolAddress, amount);
    await expect(
      pool.connect(investor).depositPortfolio([amount], 0n, 10n, feeId, deadline, feeSignature),
    ).to.be.revertedWith("Insufficient token deposit");
    expect(await feeToken.balanceOf(investor.address)).to.equal(amount);
    expect(await pool.usedQuoteIds(feeId)).to.equal(false);
  });

  it("vests shares, prevents overlapping locks, and allows claiming after expiry", async function () {
    const { investor, pool, quoteSigner, stock } = await loadFixture(deployFixture);
    const poolAddress = await pool.getAddress();
    const stockAddress = await stock.getAddress();
    const deadline = await futureDeadline(200_000);
    const amount = 100n;
    const shares = 25n;
    const firstId = makeQuoteId("locked-single-deposit");
    const firstSignature = await signSingleAssetDeposit(
      quoteSigner,
      poolAddress,
      investor.address,
      stockAddress,
      amount,
      1n,
      shares,
      firstId,
      deadline,
    );

    await stock.mint(investor.address, amount * 2n);
    await stock.connect(investor).approve(poolAddress, amount * 2n);
    await pool
      .connect(investor)
      .depositSingleAsset(stockAddress, amount, 1n, shares, firstId, deadline, firstSignature);

    expect(await pool.balanceOf(investor.address)).to.equal(0n);
    expect(await pool.balanceOf(poolAddress)).to.equal(shares);
    expect(await pool.canClaimShares(investor.address)).to.equal(false);
    await expect(pool.connect(investor).claimShares()).to.be.revertedWith("Setwise: shares are still locked");

    const secondId = makeQuoteId("overlapping-locked-deposit");
    const secondSignature = await signSingleAssetDeposit(
      quoteSigner,
      poolAddress,
      investor.address,
      stockAddress,
      amount,
      1n,
      shares,
      secondId,
      deadline,
    );
    await expect(
      pool.connect(investor).depositSingleAsset(stockAddress, amount, 1n, shares, secondId, deadline, secondSignature),
    ).to.be.revertedWith("Setwise: investor already has locked shares");

    await time.increase(86_400);
    expect(await pool.canClaimShares(investor.address)).to.equal(true);
    expect(await pool.connect(investor).claimShares.staticCall()).to.equal(shares);
    await pool.connect(investor).claimShares();
    expect(await pool.balanceOf(investor.address)).to.equal(shares);
    expect(await pool.canClaimShares(investor.address)).to.equal(false);
  });

  it("withdraws a proportional portfolio and synchronizes every asset", async function () {
    const { investor, pool, quoteSigner, secondStock, stock, wrapped } = await loadFixture(deployFixture);
    const poolAddress = await pool.getAddress();
    const amounts = [100n, 100n, 0n];
    const shares = 100n;
    const quoteId = makeQuoteId("portfolio-before-withdrawal");
    const deadline = await futureDeadline();

    await wrapped.connect(investor).deposit({ value: amounts[0] });
    await stock.mint(investor.address, amounts[1]);
    await wrapped.connect(investor).approve(poolAddress, amounts[0]);
    await stock.connect(investor).approve(poolAddress, amounts[1]);
    const signature = await signPortfolioDeposit(
      quoteSigner,
      poolAddress,
      investor.address,
      amounts,
      0n,
      shares,
      quoteId,
      deadline,
    );
    await pool.connect(investor).depositPortfolio(amounts, 0n, shares, quoteId, deadline, signature);

    await expect(pool.connect(investor).withdrawPortfolio(40n))
      .to.emit(pool, "PortfolioWithdrawn")
      .withArgs(investor.address, 40n, 4_000_000_000n);
    expect(await pool.balanceOf(investor.address)).to.equal(60n);
    expect(await wrapped.balanceOf(investor.address)).to.equal(40n);
    expect(await stock.balanceOf(investor.address)).to.equal(40n);
    expect(await secondStock.balanceOf(investor.address)).to.equal(0n);
    expect(await pool.recordedBalance(await wrapped.getAddress())).to.equal(60n);
    expect(await pool.recordedBalance(await stock.getAddress())).to.equal(60n);
    expect(await pool.recordedBalance(await secondStock.getAddress())).to.equal(0n);

    await expect(pool.connect(investor).withdrawPortfolio(61n)).to.be.revertedWith(
      "ERC20: burn amount exceeds balance",
    );
  });

  it("executes signed ERC-20 and native single-asset withdrawals", async function () {
    const { investor, other, pool, quoteSigner, stock, wrapped } = await loadFixture(deployFixture);
    const poolAddress = await pool.getAddress();
    const stockAddress = await stock.getAddress();
    const wrappedAddress = await wrapped.getAddress();
    const deadline = await futureDeadline();

    await stock.mint(investor.address, 100n);
    await stock.connect(investor).approve(poolAddress, 100n);
    const depositId = makeQuoteId("single-withdraw-deposit");
    const depositSignature = await signSingleAssetDeposit(
      quoteSigner,
      poolAddress,
      investor.address,
      stockAddress,
      100n,
      0n,
      50n,
      depositId,
      deadline,
    );
    await pool.connect(investor).depositSingleAsset(stockAddress, 100n, 0n, 50n, depositId, deadline, depositSignature);

    const withdrawalId = makeQuoteId("erc20-single-withdrawal");
    const withdrawalSignature = await signWithdrawal(
      quoteSigner,
      poolAddress,
      investor.address,
      10n,
      stockAddress,
      30n,
      withdrawalId,
      deadline,
    );
    await expect(
      pool
        .connect(investor)
        .withdrawSingleAsset(investor.address, 10n, stockAddress, 30n, withdrawalId, deadline, withdrawalSignature),
    )
      .to.emit(pool, "SingleAssetWithdrawn")
      .withArgs(investor.address, 10n, stockAddress, 30n);
    expect(await stock.balanceOf(investor.address)).to.equal(30n);

    await expect(
      pool
        .connect(other)
        .withdrawSingleAsset(investor.address, 1n, stockAddress, 1n, makeQuoteId("wrong-investor"), deadline, "0x"),
    ).to.be.revertedWith("investor does not match msg.sender");

    await wrapped.connect(investor).deposit({ value: 50n });
    await wrapped.connect(investor).approve(poolAddress, 50n);
    const wrappedDepositId = makeQuoteId("wrapped-withdraw-deposit");
    const wrappedDepositSignature = await signSingleAssetDeposit(
      quoteSigner,
      poolAddress,
      investor.address,
      wrappedAddress,
      50n,
      0n,
      20n,
      wrappedDepositId,
      deadline,
    );
    await pool
      .connect(investor)
      .depositSingleAsset(wrappedAddress, 50n, 0n, 20n, wrappedDepositId, deadline, wrappedDepositSignature);

    const nativeWithdrawalId = makeQuoteId("native-single-withdrawal");
    const nativeWithdrawalSignature = await signWithdrawal(
      quoteSigner,
      poolAddress,
      investor.address,
      5n,
      wrappedAddress,
      15n,
      nativeWithdrawalId,
      deadline,
    );
    await expect(() =>
      pool
        .connect(investor)
        .withdrawSingleAsset(
          investor.address,
          5n,
          ethers.ZeroAddress,
          15n,
          nativeWithdrawalId,
          deadline,
          nativeWithdrawalSignature,
        ),
    ).to.changeEtherBalance(investor, 15n);
    expect(await pool.recordedBalance(wrappedAddress)).to.equal(35n);
  });

  it("swaps ERC-20 for ERC-20 and validates supported assets", async function () {
    const { investor, owner, pool, quoteSigner, recipient, secondStock, stock } = await loadFixture(deployFixture);
    const poolAddress = await pool.getAddress();
    const stockAddress = await stock.getAddress();
    const outputAddress = await secondStock.getAddress();
    const deadline = await futureDeadline();
    const quoteId = makeQuoteId("asset-for-asset");
    await syncToken(pool, secondStock, owner, 200n);
    await stock.mint(investor.address, 50n);
    await stock.connect(investor).approve(poolAddress, 50n);
    const signature = await signSwapQuote(
      quoteSigner,
      poolAddress,
      investor.address,
      stockAddress,
      outputAddress,
      50n,
      20n,
      quoteId,
      deadline,
      recipient.address,
    );

    await expect(
      pool
        .connect(investor)
        .swapExactAssetForAsset(
          stockAddress,
          outputAddress,
          50n,
          20n,
          quoteId,
          deadline,
          recipient.address,
          signature,
          "0x1234",
        ),
    )
      .to.emit(pool, "SwapExecuted")
      .withArgs(stockAddress, outputAddress, recipient.address, 50n, 20n, "0x1234");
    expect(await pool.recordedBalance(stockAddress)).to.equal(50n);
    expect(await pool.recordedBalance(outputAddress)).to.equal(180n);
    expect(await secondStock.balanceOf(recipient.address)).to.equal(20n);

    await expect(
      pool
        .connect(investor)
        .swapExactAssetForAsset(
          investor.address,
          outputAddress,
          1n,
          1n,
          makeQuoteId("invalid-input"),
          deadline,
          recipient.address,
          "0x",
          "0x",
        ),
    ).to.be.revertedWith("Setwise: Invalid tokens");
  });

  it("swaps native currency for an asset and requires exact value and a supported output", async function () {
    const { investor, owner, pool, quoteSigner, recipient, stock, wrapped } = await loadFixture(deployFixture);
    const poolAddress = await pool.getAddress();
    const stockAddress = await stock.getAddress();
    const wrappedAddress = await wrapped.getAddress();
    const deadline = await futureDeadline();
    await syncToken(pool, stock, owner, 100n);

    const quoteId = makeQuoteId("native-for-stock");
    const signature = await signSwapQuote(
      quoteSigner,
      poolAddress,
      investor.address,
      wrappedAddress,
      stockAddress,
      30n,
      12n,
      quoteId,
      deadline,
      recipient.address,
    );
    await pool
      .connect(investor)
      .swapExactNativeForAsset(stockAddress, 30n, 12n, quoteId, deadline, recipient.address, signature, "0xab", {
        value: 30n,
      });
    expect(await wrapped.balanceOf(poolAddress)).to.equal(30n);
    expect(await pool.recordedBalance(wrappedAddress)).to.equal(30n);
    expect(await stock.balanceOf(recipient.address)).to.equal(12n);

    await expect(
      pool
        .connect(investor)
        .swapExactNativeForAsset(
          investor.address,
          1n,
          1n,
          makeQuoteId("native-invalid-output"),
          deadline,
          recipient.address,
          "0x",
          "0x",
          { value: 1n },
        ),
    ).to.be.revertedWith("Setwise: Invalid token");
    await expect(
      pool
        .connect(investor)
        .swapExactNativeForAsset(
          stockAddress,
          2n,
          1n,
          makeQuoteId("native-wrong-value"),
          deadline,
          recipient.address,
          "0x",
          "0x",
          { value: 1n },
        ),
    )
      .to.be.revertedWithCustomError(pool, "InvalidNativeAmount")
      .withArgs(2n, 1n);
  });

  it("swaps an asset for native currency and rolls back when the recipient rejects it", async function () {
    const { investor, owner, pool, quoteSigner, recipient, stock, wrapped } = await loadFixture(deployFixture);
    const poolAddress = await pool.getAddress();
    const stockAddress = await stock.getAddress();
    const wrappedAddress = await wrapped.getAddress();
    const deadline = await futureDeadline();
    await syncWrapped(pool, wrapped, owner, 100n);
    await stock.mint(investor.address, 40n);
    await stock.connect(investor).approve(poolAddress, 40n);

    const quoteId = makeQuoteId("stock-for-native");
    const signature = await signSwapQuote(
      quoteSigner,
      poolAddress,
      investor.address,
      stockAddress,
      wrappedAddress,
      20n,
      10n,
      quoteId,
      deadline,
      recipient.address,
    );
    await expect(() =>
      pool
        .connect(investor)
        .swapExactAssetForNative(stockAddress, 20n, 10n, quoteId, deadline, recipient.address, signature, "0x"),
    ).to.changeEtherBalance(recipient, 10n);
    expect(await pool.recordedBalance(stockAddress)).to.equal(20n);
    expect(await pool.recordedBalance(wrappedAddress)).to.equal(90n);

    const rejectFactory = await ethers.getContractFactory("MockRejectNative");
    const reject = await rejectFactory.deploy();
    const rejectAddress = await reject.getAddress();
    const rejectId = makeQuoteId("reject-native-output");
    const rejectSignature = await signSwapQuote(
      quoteSigner,
      poolAddress,
      investor.address,
      stockAddress,
      wrappedAddress,
      20n,
      10n,
      rejectId,
      deadline,
      rejectAddress,
    );
    await expect(
      pool
        .connect(investor)
        .swapExactAssetForNative(stockAddress, 20n, 10n, rejectId, deadline, rejectAddress, rejectSignature, "0x"),
    ).to.be.revertedWith("Call with value failed");
    expect(await pool.usedQuoteIds(rejectId)).to.equal(false);
    expect(await stock.balanceOf(investor.address)).to.equal(20n);
  });

  it("rejects unsupported single deposits, expired swaps, invalid signatures, zero IDs, and replay", async function () {
    const { investor, pool, quoteSigner, recipient, secondStock, stock } = await loadFixture(deployFixture);
    const poolAddress = await pool.getAddress();
    const stockAddress = await stock.getAddress();
    const outputAddress = await secondStock.getAddress();
    const deadline = await futureDeadline();

    await expect(
      pool
        .connect(investor)
        .depositSingleAsset(investor.address, 1n, 0n, 1n, makeQuoteId("unsupported-deposit"), deadline, "0x"),
    ).to.be.revertedWith("Invalid input");

    const invalidId = makeQuoteId("bad-signature");
    const wrongSignature = await signSingleAssetDeposit(
      quoteSigner,
      poolAddress,
      investor.address,
      stockAddress,
      2n,
      0n,
      1n,
      invalidId,
      deadline,
    );
    await expect(
      pool.connect(investor).depositSingleAsset(stockAddress, 3n, 0n, 1n, invalidId, deadline, wrongSignature),
    ).to.be.revertedWithCustomError(pool, "InvalidSignature");
    await expect(
      pool.connect(investor).depositSingleAsset(stockAddress, 1n, 0n, 1n, ethers.ZeroHash, deadline, "0x"),
    ).to.be.revertedWithCustomError(pool, "InvalidQuoteId");

    const now = BigInt(await time.latest());
    await expect(
      pool
        .connect(investor)
        .swapExactAssetForAsset(
          stockAddress,
          outputAddress,
          1n,
          1n,
          makeQuoteId("expired-swap"),
          now - 1n,
          recipient.address,
          "0x",
          "0x",
        ),
    ).to.be.revertedWith("Setwise: Expired");

    await stock.mint(investor.address, 2n);
    await stock.connect(investor).approve(poolAddress, 2n);
    const replayId = makeQuoteId("single-replay-full");
    const replaySignature = await signSingleAssetDeposit(
      quoteSigner,
      poolAddress,
      investor.address,
      stockAddress,
      1n,
      0n,
      1n,
      replayId,
      deadline,
    );
    await pool.connect(investor).depositSingleAsset(stockAddress, 1n, 0n, 1n, replayId, deadline, replaySignature);
    await expect(
      pool.connect(investor).depositSingleAsset(stockAddress, 1n, 0n, 1n, replayId, deadline, replaySignature),
    )
      .to.be.revertedWithCustomError(pool, "QuoteAlreadyUsed")
      .withArgs(replayId);
  });

  it("enforces deadlines on every signed standard-pool entry point", async function () {
    const { investor, pool, recipient, stock } = await loadFixture(deployFixture);
    const expired = BigInt((await time.latest()) - 1);
    const stockAddress = await stock.getAddress();

    await expect(
      pool
        .connect(investor)
        .withdrawSingleAsset(
          investor.address,
          0n,
          stockAddress,
          0n,
          makeQuoteId("expired-single-withdrawal"),
          expired,
          "0x",
        ),
    ).to.be.revertedWith("Setwise: Expired");
    await expect(
      pool
        .connect(investor)
        .swapExactNativeForAsset(
          stockAddress,
          0n,
          0n,
          makeQuoteId("expired-native-input"),
          expired,
          recipient.address,
          "0x",
          "0x",
        ),
    ).to.be.revertedWith("Setwise: Expired");
    await expect(
      pool
        .connect(investor)
        .depositSingleAsset(stockAddress, 0n, 0n, 0n, makeQuoteId("expired-single-deposit"), expired, "0x"),
    ).to.be.revertedWith("Setwise: Expired");
    await expect(
      pool
        .connect(investor)
        .swapExactAssetForNative(
          stockAddress,
          0n,
          0n,
          makeQuoteId("expired-native-output"),
          expired,
          recipient.address,
          "0x",
          "0x",
        ),
    ).to.be.revertedWith("Setwise: Expired");
  });

  it("rejects unsupported asset-to-native input", async function () {
    const { investor, pool, recipient } = await loadFixture(deployFixture);
    await expect(
      pool
        .connect(investor)
        .swapExactAssetForNative(
          investor.address,
          1n,
          1n,
          makeQuoteId("unsupported-native-output-input"),
          await futureDeadline(),
          recipient.address,
          "0x",
          "0x",
        ),
    ).to.be.revertedWith("Setwise: Invalid token");
  });

  it("covers paused branches on every standard swap implementation", async function () {
    const { investor, quoteSigner, recipient, stock, wrapped } = await loadFixture(deployFixture);
    const harnessFactory = await ethers.getContractFactory("SetwisePoolPauseHarness");
    const pool = await harnessFactory.deploy(quoteSigner.address, await wrapped.getAddress(), [
      await wrapped.getAddress(),
      await stock.getAddress(),
    ]);
    const stockAddress = await stock.getAddress();
    const deadline = await futureDeadline();
    await pool.setPaused(true);

    await expect(
      pool
        .connect(investor)
        .swapExactNativeForAsset(
          stockAddress,
          0n,
          0n,
          makeQuoteId("paused-standard-native-input"),
          deadline,
          recipient.address,
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
          makeQuoteId("paused-standard-native-output"),
          deadline,
          recipient.address,
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
          makeQuoteId("paused-standard-assets"),
          deadline,
          recipient.address,
          "0x",
          "0x",
        ),
    ).to.be.revertedWithCustomError(pool, "TradingPaused");
  });

  it("rejects reentry into every non-reentrant standard-pool operation", async function () {
    const [owner, quoteSigner, investor] = await ethers.getSigners();
    const tokenFactory = await ethers.getContractFactory("MockReentrantToken");
    const tokens = [];
    for (let i = 0; i < 8; i++) {
      tokens.push(await tokenFactory.deploy(`R${i}`));
    }
    const addresses = await Promise.all(tokens.map((token) => token.getAddress()));
    const poolFactory = await ethers.getContractFactory("SetwisePool");
    const pool = await poolFactory.deploy(quoteSigner.address, addresses[0], addresses);
    const poolAddress = await pool.getAddress();
    const callbackData = [
      pool.interface.encodeFunctionData("depositPortfolio", [[], 0n, 0n, ethers.ZeroHash, 0n, "0x"]),
      pool.interface.encodeFunctionData("withdrawSingleAsset", [
        investor.address,
        0n,
        addresses[0],
        0n,
        ethers.ZeroHash,
        0n,
        "0x",
      ]),
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
      pool.interface.encodeFunctionData("depositSingleAsset", [addresses[0], 0n, 0n, 0n, ethers.ZeroHash, 0n, "0x"]),
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
      pool.interface.encodeFunctionData("claimShares"),
      pool.interface.encodeFunctionData("withdrawPortfolio", [0n]),
    ];

    for (let i = 0; i < tokens.length; i++) {
      await tokens[i].mint(investor.address, 1n);
      await tokens[i].connect(investor).approve(poolAddress, 1n);
      await tokens[i].connect(owner).configureCallback(poolAddress, callbackData[i]);
    }

    const amounts = Array<bigint>(8).fill(1n);
    const quoteId = makeQuoteId("standard-reentry-batch");
    const deadline = await futureDeadline();
    const signature = await signPortfolioDeposit(
      quoteSigner,
      poolAddress,
      investor.address,
      amounts,
      0n,
      8n,
      quoteId,
      deadline,
    );
    await pool.connect(investor).depositPortfolio(amounts, 0n, 8n, quoteId, deadline, signature);
    expect(await pool.balanceOf(investor.address)).to.equal(8n);
  });
});
