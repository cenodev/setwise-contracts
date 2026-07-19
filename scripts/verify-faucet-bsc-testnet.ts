import { ethers, network } from "hardhat";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { BscTestnetDeployment } from "./faucet-config";

async function main(): Promise<void> {
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== 97n) throw new Error(`This script is restricted to BSC Testnet; connected to chain ${chainId}`);

  const deploymentPath = path.join(process.cwd(), "deployments", `${network.name}.json`);
  const deployment = JSON.parse(await readFile(deploymentPath, "utf8")) as BscTestnetDeployment;
  if (!deployment.faucet) throw new Error("Faucet is missing from the deployment manifest");
  if (
    deployment.faucet.tokens.some(({ address }) => address.toLowerCase() === deployment.mockWrappedNative.toLowerCase())
  ) {
    throw new Error("Mock wrapped BNB must not be configured in the free ERC-20 basket");
  }

  const faucet = await ethers.getContractAt("SetwiseMockTokenFaucet", deployment.faucet.address);
  const count = await faucet.assetCount();
  if (count !== BigInt(deployment.faucet.tokens.length)) {
    throw new Error(`Faucet exposes ${count} assets; manifest contains ${deployment.faucet.tokens.length}`);
  }
  if ((await faucet.cooldown()).toString() !== deployment.faucet.cooldownSeconds) {
    throw new Error("On-chain cooldown does not match the manifest");
  }
  if ((await faucet.owner()).toLowerCase() !== deployment.faucet.owner.toLowerCase()) {
    throw new Error("On-chain faucet owner does not match the manifest");
  }

  const inventory: Array<{ symbol: string; claimsRemaining: string }> = [];
  for (const [index, expected] of deployment.faucet.tokens.entries()) {
    const [token, claimAmount, balance] = await faucet.assetAt(index);
    if (token.toLowerCase() !== expected.address.toLowerCase()) throw new Error(`Token mismatch at index ${index}`);
    if (claimAmount.toString() !== expected.claimAmountAtomic)
      throw new Error(`Claim amount mismatch for ${expected.symbol}`);
    if (balance < claimAmount) throw new Error(`Insufficient live inventory for ${expected.symbol}`);

    const ownedToken = await ethers.getContractAt(["function owner() view returns (address)"], token);
    const tokenOwner = await ownedToken.owner();
    if (tokenOwner.toLowerCase() === deployment.faucet.address.toLowerCase()) {
      throw new Error(`Faucet unexpectedly owns ${expected.symbol}`);
    }
    if (deployment.deployer && tokenOwner.toLowerCase() !== deployment.deployer.toLowerCase()) {
      throw new Error(`Ownership of ${expected.symbol} changed from the recorded deployer`);
    }
    inventory.push({ symbol: expected.symbol, claimsRemaining: (balance / claimAmount).toString() });
  }

  const simulationWallet = ethers.Wallet.createRandom().connect(ethers.provider);
  await faucet.connect(simulationWallet).claim.staticCall();

  console.log(
    JSON.stringify(
      {
        address: deployment.faucet.address,
        cooldownSeconds: deployment.faucet.cooldownSeconds,
        paused: await faucet.paused(),
        inventory,
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
