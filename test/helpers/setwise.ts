import type { Signer } from "ethers";
import { ethers } from "hardhat";

const domain = async (poolAddress: string) => ({
  chainId: (await ethers.provider.getNetwork()).chainId,
  name: "SetwisePool",
  verifyingContract: poolAddress,
  version: "2.0.0",
});

export const portfolioDepositTypes = {
  PortfolioDeposit: [
    { name: "investor", type: "address" },
    { name: "depositAmounts", type: "uint256[]" },
    { name: "lockDays", type: "uint256" },
    { name: "shares", type: "uint256" },
    { name: "quoteId", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
};

export const singleAssetDepositTypes = {
  SingleAssetDeposit: [
    { name: "investor", type: "address" },
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "lockDays", type: "uint256" },
    { name: "shares", type: "uint256" },
    { name: "quoteId", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
};

export const withdrawalTypes = {
  SingleAssetWithdrawal: [
    { name: "investor", type: "address" },
    { name: "sharesToBurn", type: "uint256" },
    { name: "asset", type: "address" },
    { name: "assetAmount", type: "uint256" },
    { name: "quoteId", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
};

export const swapQuoteTypes = {
  SwapQuote: [
    { name: "payer", type: "address" },
    { name: "inputAsset", type: "address" },
    { name: "outputAsset", type: "address" },
    { name: "inputAmount", type: "uint256" },
    { name: "outputAmount", type: "uint256" },
    { name: "quoteId", type: "bytes32" },
    { name: "deadline", type: "uint256" },
    { name: "recipient", type: "address" },
  ],
};

export async function futureDeadline(seconds = 3_600): Promise<bigint> {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp + seconds);
}

export function makeQuoteId(label: string): string {
  return ethers.id(label);
}

export async function signPortfolioDeposit(
  signer: Signer,
  poolAddress: string,
  investor: string,
  depositAmounts: bigint[],
  lockDays: bigint,
  shares: bigint,
  quoteId: string,
  deadline: bigint,
): Promise<string> {
  return signer.signTypedData(await domain(poolAddress), portfolioDepositTypes, {
    deadline,
    depositAmounts,
    investor,
    lockDays,
    quoteId,
    shares,
  });
}

export async function signSingleAssetDeposit(
  signer: Signer,
  poolAddress: string,
  investor: string,
  asset: string,
  amount: bigint,
  lockDays: bigint,
  shares: bigint,
  quoteId: string,
  deadline: bigint,
): Promise<string> {
  return signer.signTypedData(await domain(poolAddress), singleAssetDepositTypes, {
    amount,
    asset,
    deadline,
    investor,
    lockDays,
    quoteId,
    shares,
  });
}

export async function signWithdrawal(
  signer: Signer,
  poolAddress: string,
  investor: string,
  sharesToBurn: bigint,
  asset: string,
  assetAmount: bigint,
  quoteId: string,
  deadline: bigint,
): Promise<string> {
  return signer.signTypedData(await domain(poolAddress), withdrawalTypes, {
    asset,
    assetAmount,
    deadline,
    investor,
    quoteId,
    sharesToBurn,
  });
}

export async function signSwapQuote(
  signer: Signer,
  poolAddress: string,
  payer: string,
  inputAsset: string,
  outputAsset: string,
  inputAmount: bigint,
  outputAmount: bigint,
  quoteId: string,
  deadline: bigint,
  recipient: string,
): Promise<string> {
  return signer.signTypedData(await domain(poolAddress), swapQuoteTypes, {
    deadline,
    inputAmount,
    inputAsset,
    outputAmount,
    outputAsset,
    payer,
    quoteId,
    recipient,
  });
}

export function packGoodUntil(
  offchainX: bigint,
  offchainY: bigint,
  rawMultiplierX: bigint,
  rawMultiplierY: bigint,
  deadline: bigint,
): bigint {
  return (
    (offchainX << 160n) |
    (offchainY << 64n) |
    (rawMultiplierX << 48n) |
    (rawMultiplierY << 32n) |
    (deadline & 0xffffffffn)
  );
}
