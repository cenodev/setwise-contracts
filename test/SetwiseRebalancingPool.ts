import { expect } from "chai";
import { ethers } from "hardhat";

describe("SetwiseRebalancingPool", function () {
  async function deployFixture() {
    const [owner, quoteSigner, guardian] = await ethers.getSigners();
    const mockFactory = await ethers.getContractFactory("MockERC20");
    const wrappedNative = await mockFactory.deploy("Wrapped Native", "WNATIVE");
    const stock = await mockFactory.deploy("Tokenized Stock", "STOCK");

    const poolFactory = await ethers.getContractFactory("SetwiseRebalancingPool");
    const pool = await poolFactory.deploy(quoteSigner.address, await wrappedNative.getAddress(), [
      await wrappedNative.getAddress(),
      await stock.getAddress(),
    ]);

    return { guardian, owner, pool, quoteSigner, stock, wrappedNative };
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
});
