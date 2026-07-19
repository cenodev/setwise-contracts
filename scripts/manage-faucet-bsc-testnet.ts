import { ethers, network } from "hardhat";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { BscTestnetDeployment } from "./faucet-config";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== 97n) throw new Error(`This script is restricted to BSC Testnet; connected to chain ${chainId}`);
  const [operator] = await ethers.getSigners();
  if (!operator) throw new Error("Configure DEPLOYER_PRIVATE_KEY for the faucet owner");

  const deploymentPath = path.join(process.cwd(), "deployments", `${network.name}.json`);
  const deployment = JSON.parse(await readFile(deploymentPath, "utf8")) as BscTestnetDeployment;
  if (!deployment.faucet) throw new Error("Faucet is missing from the deployment manifest");
  const faucet = await ethers.getContractAt("SetwiseMockTokenFaucet", deployment.faucet.address, operator);
  const action = required("FAUCET_ACTION");

  let transaction;
  if (action === "pause") transaction = await faucet.pause();
  else if (action === "unpause") transaction = await faucet.unpause();
  else if (action === "set-amount") {
    transaction = await faucet.setClaimAmount(required("TOKEN_ADDRESS"), BigInt(required("CLAIM_AMOUNT_ATOMIC")));
  } else if (action === "recover") {
    transaction = await faucet.recoverInventory(
      required("TOKEN_ADDRESS"),
      required("RECIPIENT_ADDRESS"),
      BigInt(required("RECOVERY_AMOUNT_ATOMIC")),
    );
  } else {
    throw new Error("FAUCET_ACTION must be pause, unpause, set-amount, or recover");
  }

  await transaction.wait();
  console.log(`${action} confirmed: ${transaction.hash}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
