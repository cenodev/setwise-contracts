import { ethers, network } from "hardhat";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { type BscTestnetDeployment, parsePositiveInteger, writeDeploymentOutputs } from "./faucet-config";

async function main(): Promise<void> {
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== 97n) throw new Error(`This script is restricted to BSC Testnet; connected to chain ${chainId}`);

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("Configure DEPLOYER_PRIVATE_KEY before topping up");

  const deploymentPath = path.join(process.cwd(), "deployments", `${network.name}.json`);
  const deployment = JSON.parse(await readFile(deploymentPath, "utf8")) as BscTestnetDeployment;
  if (!deployment.faucet) throw new Error("Deploy the faucet before topping it up");
  const claims = parsePositiveInteger(process.env.FAUCET_TOP_UP_CLAIMS, 250n, "FAUCET_TOP_UP_CLAIMS");
  const transactions: Array<{ token: string; amountAtomic: string; hash: string }> = [];

  for (const asset of deployment.faucet.tokens) {
    const amount = BigInt(asset.claimAmountAtomic) * claims;
    const token = await ethers.getContractAt("IERC20", asset.address, deployer);
    const transaction = await token.transfer(deployment.faucet.address, amount);
    await transaction.wait();
    transactions.push({ token: asset.address, amountAtomic: amount.toString(), hash: transaction.hash });
  }

  deployment.topUps = [
    ...(deployment.topUps ?? []),
    { at: new Date().toISOString(), claims: claims.toString(), transactions },
  ];
  await writeDeploymentOutputs(deployment, deploymentPath);
  console.log(JSON.stringify(deployment.topUps.at(-1), null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
