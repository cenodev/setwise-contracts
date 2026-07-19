import { ethers, network } from "hardhat";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  type BscTestnetDeployment,
  configuredFaucetAssets,
  deployAndFundFaucet,
  parsePositiveInteger,
  writeDeploymentOutputs,
} from "./faucet-config";

async function main(): Promise<void> {
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== 97n) throw new Error(`This script is restricted to BSC Testnet; connected to chain ${chainId}`);

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("Configure DEPLOYER_PRIVATE_KEY before deploying");

  const deploymentPath = path.join(process.cwd(), "deployments", `${network.name}.json`);
  const deployment = JSON.parse(await readFile(deploymentPath, "utf8")) as BscTestnetDeployment;
  if (deployment.chainId !== 97) throw new Error(`Manifest is for chain ${deployment.chainId}, expected 97`);
  if (deployment.faucet && process.env.REDEPLOY_FAUCET !== "true") {
    throw new Error(
      `Manifest already contains faucet ${deployment.faucet.address}; set REDEPLOY_FAUCET=true intentionally`,
    );
  }

  const deployerAddress = await deployer.getAddress();
  const owner = process.env.SETWISE_FAUCET_OWNER ?? deployerAddress;
  const fundingClaims = parsePositiveInteger(process.env.FAUCET_FUNDING_CLAIMS, 500n, "FAUCET_FUNDING_CLAIMS");
  const assets = configuredFaucetAssets(deployment);

  deployment.faucet = await deployAndFundFaucet(deployer, assets, owner, fundingClaims);
  await writeDeploymentOutputs(deployment, deploymentPath);

  console.log(JSON.stringify(deployment.faucet, null, 2));
  console.log(`Faucet deployment and app config written for ${network.name}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
