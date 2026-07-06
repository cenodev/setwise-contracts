import { ethers, upgrades } from "hardhat";

async function main(): Promise<void> {
  const proxyAddress = process.env.SETWISE_PROXY_ADDRESS;
  if (!proxyAddress || !ethers.isAddress(proxyAddress)) {
    throw new Error("Set SETWISE_PROXY_ADDRESS to the deployed UUPS proxy address");
  }

  const [signer] = await ethers.getSigners();
  const currentImplementation = await upgrades.erc1967.getImplementationAddress(proxyAddress);
  const poolFactory = await ethers.getContractFactory("SetwiseRebalancingPool", signer);

  console.log("Proxy:", proxyAddress);
  console.log("Current implementation:", currentImplementation);
  await upgrades.validateUpgrade(proxyAddress, poolFactory, { kind: "uups" });

  const pool = await upgrades.upgradeProxy(proxyAddress, poolFactory, { kind: "uups" });
  await pool.waitForDeployment();
  const newImplementation = await upgrades.erc1967.getImplementationAddress(proxyAddress);
  console.log("New implementation:", newImplementation);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
