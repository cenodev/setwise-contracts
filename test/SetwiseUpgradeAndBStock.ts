import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers, upgrades } from "hardhat";

import { futureDeadline, makeQuoteId, signSingleAssetDeposit } from "./helpers/setwise";

describe("Setwise upgrades and mock bStocks", function () {
  async function deployProxyFixture() {
    const [owner, quoteSigner, investor, guardian, other] = await ethers.getSigners();
    const wrappedFactory = await ethers.getContractFactory("MockWrappedNative");
    const wrapped = await wrappedFactory.deploy();
    const tokenFactory = await ethers.getContractFactory("MockERC20");
    const stock = await tokenFactory.deploy("Tokenized Stock", "STOCK");
    const factory = await ethers.getContractFactory("SetwiseRebalancingPool");
    const pool = await upgrades.deployProxy(
      factory,
      [quoteSigner.address, await wrapped.getAddress(), [await wrapped.getAddress(), await stock.getAddress()]],
      { kind: "uups" },
    );
    await pool.waitForDeployment();

    return { factory, guardian, investor, other, owner, pool, quoteSigner, stock, wrapped };
  }

  it("locks the implementation and prevents proxy reinitialization", async function () {
    const { factory, pool, quoteSigner, stock, wrapped } = await loadFixture(deployProxyFixture);
    const implementationAddress = await upgrades.erc1967.getImplementationAddress(await pool.getAddress());
    const implementation = factory.attach(implementationAddress);
    const initializerArgs = [
      quoteSigner.address,
      await wrapped.getAddress(),
      [await wrapped.getAddress(), await stock.getAddress()],
    ] as const;

    await expect(implementation.initialize(...initializerArgs)).to.be.revertedWith(
      "Initializable: contract is already initialized",
    );
    await expect(pool.initialize(...initializerArgs)).to.be.revertedWith(
      "Initializable: contract is already initialized",
    );

    const standardFactory = await ethers.getContractFactory("SetwisePool");
    const standardPool = await upgrades.deployProxy(standardFactory, initializerArgs, { kind: "uups" });
    await expect(standardPool.initialize(...initializerArgs)).to.be.revertedWith(
      "Initializable: contract is already initialized",
    );

    const harnessFactory = await ethers.getContractFactory("SetwisePoolPauseHarness");
    const harness = await upgrades.deployProxy(harnessFactory, initializerArgs, { kind: "uups" });
    await expect(harness.exposedSetwisePoolInitializer(...initializerArgs)).to.be.revertedWith(
      "Initializable: contract is not initializing",
    );
    await expect(harness.exposedSetwisePoolBaseInitializer(...initializerArgs)).to.be.revertedWith(
      "Initializable: contract is not initializing",
    );
  });

  it("preserves pool state across an owner-authorized UUPS upgrade", async function () {
    const { guardian, investor, other, owner, pool, quoteSigner, stock, wrapped } =
      await loadFixture(deployProxyFixture);
    const proxyAddress = await pool.getAddress();
    const stockAddress = await stock.getAddress();
    const wrappedAddress = await wrapped.getAddress();
    const deadline = await futureDeadline();
    const quoteId = makeQuoteId("pre-upgrade-deposit");
    const signature = await signSingleAssetDeposit(
      quoteSigner,
      proxyAddress,
      investor.address,
      stockAddress,
      100n,
      0n,
      25n,
      quoteId,
      deadline,
    );
    await stock.mint(investor.address, 100n);
    await stock.connect(investor).approve(proxyAddress, 100n);
    await pool.connect(investor).depositSingleAsset(stockAddress, 100n, 0n, 25n, quoteId, deadline, signature);
    await pool.setGuardian(guardian.address);

    const v2Factory = await ethers.getContractFactory("SetwiseRebalancingPoolV2");
    const v2Implementation = await upgrades.deployImplementation(v2Factory, { kind: "uups" });
    await expect(pool.connect(other).upgradeTo(v2Implementation)).to.be.revertedWith(
      "Ownable: caller is not the owner",
    );

    const upgraded = await upgrades.upgradeProxy(proxyAddress, v2Factory, {
      call: { fn: "initializeV2", args: [42n] },
      kind: "uups",
    });
    await upgraded.waitForDeployment();

    expect(await upgraded.getAddress()).to.equal(proxyAddress);
    expect(await upgraded.implementationVersion()).to.equal(2n);
    expect(await upgraded.upgradeMarker()).to.equal(42n);
    expect(await upgraded.owner()).to.equal(owner.address);
    expect(await upgraded.guardian()).to.equal(guardian.address);
    expect(await upgraded.QUOTE_SIGNER()).to.equal(quoteSigner.address);
    expect(await upgraded.WRAPPED_NATIVE_TOKEN()).to.equal(wrappedAddress);
    expect(await upgraded.balanceOf(investor.address)).to.equal(25n);
    expect(await upgraded.recordedBalance(stockAddress)).to.equal(100n);
    expect(await upgraded.usedQuoteIds(quoteId)).to.equal(true);
  });

  it("models bStock raw balances and scaled UI amounts independently", async function () {
    const [owner, investor, other] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("MockBStock");
    const stock = await factory.deploy("Mock NVIDIA bStock", "mbNVDA", owner.address);
    const amount = ethers.parseEther("10");

    await expect(stock.connect(other).mint(investor.address, amount)).to.be.revertedWith(
      "Ownable: caller is not the owner",
    );
    await stock.mint(investor.address, amount);
    expect(await stock.balanceOf(investor.address)).to.equal(amount);
    expect(await stock.scaledBalanceOf(investor.address)).to.equal(amount);

    await expect(stock.updateUIMultiplier(2n * 10n ** 18n))
      .to.emit(stock, "UIMultiplierUpdated")
      .withArgs(10n ** 18n, 2n * 10n ** 18n, anyValue);
    expect(await stock.balanceOf(investor.address)).to.equal(amount);
    expect(await stock.scaledBalanceOf(investor.address)).to.equal(amount * 2n);
    expect(await stock.scaledTotalSupply()).to.equal(amount * 2n);

    await expect(stock.updateUIMultiplier(0n)).to.be.revertedWithCustomError(stock, "InvalidMultiplier");
    await expect(stock.connect(other).updateUIMultiplier(10n ** 18n)).to.be.revertedWith(
      "Ownable: caller is not the owner",
    );
    await expect(stock.connect(other).burn(investor.address, 1n)).to.be.revertedWith(
      "Ownable: caller is not the owner",
    );
    await stock.burn(investor.address, ethers.parseEther("1"));
    expect(await stock.balanceOf(investor.address)).to.equal(ethers.parseEther("9"));

    const interfaceId = stock.interface.getFunction("uiMultiplier").selector;
    expect(await stock.supportsInterface(interfaceId)).to.equal(true);
    expect(await stock.supportsInterface("0x01ffc9a7")).to.equal(true);
    expect(await stock.supportsInterface("0xffffffff")).to.equal(false);
  });

  it("wraps and unwraps BNB through explicit deposit and receive paths", async function () {
    const [owner] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("MockWrappedBNB");
    const wrapped = await factory.deploy();
    const wrappedAddress = await wrapped.getAddress();

    await wrapped.deposit({ value: 10n });
    await owner.sendTransaction({ to: wrappedAddress, value: 5n });
    expect(await wrapped.balanceOf(owner.address)).to.equal(15n);
    await wrapped.withdraw(6n);
    expect(await wrapped.balanceOf(owner.address)).to.equal(9n);

    const rejectorFactory = await ethers.getContractFactory("MockWrappedNativeRejector");
    const rejector = await rejectorFactory.deploy();
    await expect(rejector.depositAndWithdraw(wrappedAddress, { value: 1n })).to.be.revertedWith(
      "native transfer failed",
    );
  });

  it("provides an owner-mintable 18-decimal mock USDT", async function () {
    const [owner, investor, other] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("MockUSDT");
    const usdt = await factory.deploy(owner.address);

    expect(await usdt.name()).to.equal("Mock Tether USD");
    expect(await usdt.symbol()).to.equal("mUSDT");
    expect(await usdt.decimals()).to.equal(18n);
    await expect(usdt.connect(other).mint(investor.address, 1n)).to.be.revertedWith("Ownable: caller is not the owner");
    await usdt.mint(investor.address, ethers.parseUnits("1000", 18));
    await expect(usdt.connect(other).burn(investor.address, 1n)).to.be.revertedWith("Ownable: caller is not the owner");
    await usdt.burn(investor.address, ethers.parseUnits("100", 18));
    expect(await usdt.balanceOf(investor.address)).to.equal(ethers.parseUnits("900", 18));
  });
});
