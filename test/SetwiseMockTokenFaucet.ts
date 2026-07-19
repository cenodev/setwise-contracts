import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

describe("SetwiseMockTokenFaucet", function () {
  const cooldown = 24 * 60 * 60;
  const firstAmount = ethers.parseUnits("1000", 18);
  const secondAmount = ethers.parseUnits("10", 18);

  async function deployFixture() {
    const [owner, claimant, other] = await ethers.getSigners();
    const tokenFactory = await ethers.getContractFactory("MockERC20");
    const first = await tokenFactory.deploy("Mock USD", "mUSD");
    const second = await tokenFactory.deploy("Mock Stock", "mbSTOCK");
    const faucetFactory = await ethers.getContractFactory("SetwiseMockTokenFaucet");
    const faucet = await faucetFactory.deploy(
      [await first.getAddress(), await second.getAddress()],
      [firstAmount, secondAmount],
      cooldown,
      owner.address,
    );
    const inventory = ethers.parseUnits("100000", 18);
    await first.mint(await faucet.getAddress(), inventory);
    await second.mint(await faucet.getAddress(), inventory);
    return { claimant, faucet, first, other, owner, second };
  }

  it("transfers the complete basket and records the next eligible time", async function () {
    const { claimant, faucet, first, second } = await loadFixture(deployFixture);
    const transaction = await faucet.connect(claimant).claim();
    const receipt = await transaction.wait();
    const block = await ethers.provider.getBlock(receipt!.blockNumber);
    const nextEligible = BigInt(block!.timestamp + cooldown);

    expect(await first.balanceOf(claimant.address)).to.equal(firstAmount);
    expect(await second.balanceOf(claimant.address)).to.equal(secondAmount);
    expect(await faucet.nextEligibleAt(claimant.address)).to.equal(nextEligible);
    await expect(transaction).to.emit(faucet, "Claimed").withArgs(claimant.address, nextEligible);
  });

  it("rejects a second claim atomically during cooldown and succeeds afterward", async function () {
    const { claimant, faucet, first, second } = await loadFixture(deployFixture);
    await faucet.connect(claimant).claim();
    const eligibleAt = await faucet.nextEligibleAt(claimant.address);

    await expect(faucet.connect(claimant).claim())
      .to.be.revertedWithCustomError(faucet, "CooldownActive")
      .withArgs(eligibleAt);
    expect(await first.balanceOf(claimant.address)).to.equal(firstAmount);
    expect(await second.balanceOf(claimant.address)).to.equal(secondAmount);

    await time.increaseTo(eligibleAt);
    await faucet.connect(claimant).claim();
    expect(await first.balanceOf(claimant.address)).to.equal(firstAmount * 2n);
    expect(await second.balanceOf(claimant.address)).to.equal(secondAmount * 2n);
  });

  it("rejects paused and insufficient-inventory claims without partial transfers", async function () {
    const { claimant, faucet, first, owner, second } = await loadFixture(deployFixture);
    await faucet.pause();
    await expect(faucet.connect(claimant).claim()).to.be.revertedWithCustomError(faucet, "FaucetPaused");
    await faucet.unpause();
    await faucet.recoverInventory(
      await second.getAddress(),
      owner.address,
      await second.balanceOf(await faucet.getAddress()),
    );

    await expect(faucet.connect(claimant).claim())
      .to.be.revertedWithCustomError(faucet, "InsufficientInventory")
      .withArgs(await second.getAddress(), secondAmount, 0);
    expect(await first.balanceOf(claimant.address)).to.equal(0);
    expect(await faucet.nextEligibleAt(claimant.address)).to.equal(0);
  });

  it("validates empty, mismatched, zero, and duplicate configurations", async function () {
    const { faucet, first, second } = await loadFixture(deployFixture);
    const firstAddress = await first.getAddress();
    const secondAddress = await second.getAddress();

    await expect(faucet.setConfiguration([], [])).to.be.revertedWithCustomError(faucet, "EmptyConfiguration");
    await expect(faucet.setConfiguration([firstAddress], [])).to.be.revertedWithCustomError(
      faucet,
      "InvalidConfigurationLength",
    );
    await expect(faucet.setConfiguration([ethers.ZeroAddress], [1])).to.be.revertedWithCustomError(
      faucet,
      "InvalidToken",
    );
    await expect(faucet.setConfiguration([firstAddress], [0])).to.be.revertedWithCustomError(faucet, "ZeroClaimAmount");
    await expect(faucet.setConfiguration([firstAddress, firstAddress], [1, 2])).to.be.revertedWithCustomError(
      faucet,
      "DuplicateToken",
    );

    await faucet.setConfiguration([secondAddress], [3]);
    expect(await faucet.assetCount()).to.equal(1);
    expect(await faucet.assetAt(0)).to.deep.equal([
      secondAddress,
      3n,
      await second.balanceOf(await faucet.getAddress()),
    ]);
  });

  it("handles configuration boundaries with exact atomic accounting", async function () {
    const { claimant, faucet } = await loadFixture(deployFixture);
    const tokenFactory = await ethers.getContractFactory("MockERC20");
    const tokens: string[] = [];
    const amounts: bigint[] = [];
    const contracts = [];
    for (let index = 1; index <= 24; index += 1) {
      const token = await tokenFactory.deploy(`Boundary ${index}`, `B${index}`);
      const amount = BigInt(index) * 1_000_000_000_000_003n;
      await token.mint(await faucet.getAddress(), amount);
      tokens.push(await token.getAddress());
      amounts.push(amount);
      contracts.push(token);
    }

    await faucet.setConfiguration(tokens, amounts);
    await faucet.connect(claimant).claim();
    for (const [index, token] of contracts.entries()) {
      expect(await token.balanceOf(claimant.address)).to.equal(amounts[index]);
      expect(await token.balanceOf(await faucet.getAddress())).to.equal(0);
    }
  });

  it("bubbles nonstandard ERC-20 failure and blocks reentrancy", async function () {
    const { claimant, faucet } = await loadFixture(deployFixture);
    const falseFactory = await ethers.getContractFactory("MockFalseReturningToken");
    const falseToken = await falseFactory.deploy();
    await falseToken.mint(await faucet.getAddress(), 10);
    await faucet.setConfiguration([await falseToken.getAddress()], [1]);
    await expect(faucet.connect(claimant).claim()).to.be.revertedWith("SafeERC20: ERC20 operation did not succeed");
    expect(await faucet.nextEligibleAt(claimant.address)).to.equal(0);

    const reentrantFactory = await ethers.getContractFactory("MockReentrantToken");
    const reentrant = await reentrantFactory.deploy("REENTER");
    await reentrant.mint(await faucet.getAddress(), 10);
    await faucet.setConfiguration([await reentrant.getAddress()], [1]);
    await reentrant.configureCallback(await faucet.getAddress(), faucet.interface.encodeFunctionData("claim"));
    await faucet.connect(claimant).claim();
    expect(await reentrant.balanceOf(claimant.address)).to.equal(1);
  });

  it("restricts configuration, pause, amount changes, and recovery to the owner", async function () {
    const { faucet, first, other } = await loadFixture(deployFixture);
    const firstAddress = await first.getAddress();
    await expect(faucet.connect(other).pause()).to.be.revertedWith("Ownable: caller is not the owner");
    await expect(faucet.connect(other).unpause()).to.be.revertedWith("Ownable: caller is not the owner");
    await expect(faucet.connect(other).setConfiguration([firstAddress], [1])).to.be.revertedWith(
      "Ownable: caller is not the owner",
    );
    await expect(faucet.connect(other).setClaimAmount(firstAddress, 1)).to.be.revertedWith(
      "Ownable: caller is not the owner",
    );
    await expect(faucet.connect(other).recoverInventory(firstAddress, other.address, 1)).to.be.revertedWith(
      "Ownable: caller is not the owner",
    );

    await faucet.setClaimAmount(firstAddress, 7);
    expect((await faucet.assetAt(0))[1]).to.equal(7);
    await expect(faucet.setClaimAmount(other.address, 1)).to.be.revertedWithCustomError(faucet, "UnknownToken");
  });
});
