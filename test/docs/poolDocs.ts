import { expect } from "chai";
import { ethers } from "ethers";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import rebalancingArtifact from "../../artifacts/contracts/SetwiseRebalancingPool.sol/SetwiseRebalancingPool.json";
import bscTestnet from "../../deployments/bsc-testnet.json";
import bscTestnetNoBnb from "../../deployments/bsc-testnet.no-bnb.json";
import bscTestnetNoBnbRfq from "../../deployments/bsc-testnet.no-bnb.rfq-pool-config.json";
import bscTestnetRfq from "../../deployments/bsc-testnet.rfq-pool-config.json";
import baseline from "../../docs/baseline/pool-interface.json";

const repoRoot = join(__dirname, "..", "..");
const docFiles = [
  "docs/README.md",
  "docs/POOL_INTERFACE.md",
  "docs/POOL_ACCOUNTING.md",
  "docs/POOL_SECURITY.md",
  "docs/POOL_DEPLOYMENTS.md",
  "docs/POOL_INTEGRATION.md",
];

function loadInterface(): ethers.Interface {
  return new ethers.Interface(rebalancingArtifact.abi);
}

describe("pool documentation", function () {
  const iface = loadInterface();

  it("includes every published guide", function () {
    for (const relativePath of docFiles) {
      expect(existsSync(join(repoRoot, relativePath)), relativePath).to.equal(true);
    }
  });

  it("uses Set in user-facing docs while keeping pool identifiers internal", function () {
    const integration = readFileSync(join(repoRoot, "docs/POOL_INTEGRATION.md"), "utf8");
    expect(integration).to.include("**Set**");
    expect(integration).to.include("poolId");
    expect(integration).to.include("poolAddress");
  });

  it("matches swap function selectors to the compiled artifact", function () {
    for (const [name, entry] of Object.entries(baseline.functions)) {
      const fn = iface.getFunction(name);
      expect(fn, name).to.not.equal(null);
      expect(fn!.selector).to.equal(entry.selector);
      expect(fn!.format("sighash")).to.equal(entry.signature);
      if ("stateMutability" in entry) {
        expect(fn!.stateMutability).to.equal(entry.stateMutability);
      }
    }
  });

  it("matches EIP-712 typehashes to ethers.id of the documented type strings", function () {
    for (const [name, entry] of Object.entries(baseline.eip712.types)) {
      expect(ethers.id(entry.type), name).to.equal(entry.typehash);
    }
    expect(baseline.eip712.domain.name).to.equal("SetwisePool");
    expect(baseline.eip712.domain.version).to.equal("2.0.0");
  });

  it("matches events and errors to the compiled artifact", function () {
    for (const [name, entry] of Object.entries(baseline.events)) {
      const event = iface.getEvent(name);
      expect(event!.topicHash).to.equal(entry.topicHash);
      expect(event!.format("sighash")).to.equal(entry.signature);
    }

    for (const [name, entry] of Object.entries(baseline.errors)) {
      const error = iface.getError(name);
      expect(error!.selector).to.equal(entry.selector);
      expect(error!.format("sighash")).to.equal(entry.signature);
    }
  });

  it("documents only the payable native-input swap entry point", function () {
    const swapNames = ["swapExactAssetForAsset", "swapExactNativeForAsset", "swapExactAssetForNative"];
    for (const name of swapNames) {
      const fn = iface.getFunction(name)!;
      const shouldBePayable = name === "swapExactNativeForAsset";
      expect(fn.stateMutability === "payable").to.equal(shouldBePayable);
    }
  });

  it("links deployment manifests to RFQ configs and artifact paths", function () {
    const cases = [
      { manifest: bscTestnet, rfq: bscTestnetRfq[0], poolId: "bstock-ai-bsc-testnet" },
      { manifest: bscTestnetNoBnb, rfq: bscTestnetNoBnbRfq[0], poolId: "bstock-ai-no-bnb-bsc-testnet" },
    ];

    for (const { manifest, rfq, poolId } of cases) {
      expect(rfq.poolAddress.toLowerCase()).to.equal(manifest.poolProxy.toLowerCase());
      expect(rfq.chainId).to.equal(manifest.chainId);
      expect(rfq.id).to.equal(poolId);
      expect(rfq.contractVersion).to.equal(baseline.eip712.domain.version);
      expect(existsSync(join(repoRoot, baseline.source.artifact))).to.equal(true);
    }
  });

  it("lists required manifest fields referenced in deployment docs", function () {
    for (const manifest of [bscTestnet, bscTestnetNoBnb]) {
      expect(manifest.poolProxy).to.be.a("string");
      expect(manifest.poolImplementation).to.be.a("string");
      expect(manifest.quoteSigner).to.be.a("string");
      expect(manifest.poolOwner).to.be.a("string");
      expect(manifest.chainId).to.equal(97);
      expect(manifest.network).to.equal("bsc-testnet");
    }
  });
});
