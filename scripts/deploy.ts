import { ethers, upgrades } from "hardhat";

async function main(): Promise<void> {
  const quoteSigner = process.env.SETWISE_QUOTE_SIGNER;
  const wrappedNativeToken = process.env.SETWISE_WRAPPED_NATIVE_TOKEN;
  const supportedAssets = (process.env.SETWISE_ASSETS ?? "")
    .split(",")
    .map((asset) => asset.trim())
    .filter(Boolean);

  if (!quoteSigner || !wrappedNativeToken || supportedAssets.length === 0) {
    throw new Error(
      "Set SETWISE_QUOTE_SIGNER, SETWISE_WRAPPED_NATIVE_TOKEN, and comma-separated SETWISE_ASSETS before deploying",
    );
  }

  const poolFactory = await ethers.getContractFactory("SetwiseRebalancingPool");
  const pool = await upgrades.deployProxy(poolFactory, [quoteSigner, wrappedNativeToken, supportedAssets], {
    kind: "uups",
  });
  await pool.waitForDeployment();

  const proxyAddress = await pool.getAddress();
  const implementationAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);
  console.log("SetwiseRebalancingPool proxy:", proxyAddress);
  console.log("SetwiseRebalancingPool implementation:", implementationAddress);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
