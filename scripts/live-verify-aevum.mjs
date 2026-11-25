#!/usr/bin/env node
/**
 * Live On-Chain End-to-End Verification Script for PayeeShield on QDay Aevum Testnet (Chain ID 44005).
 *
 * Executes real live transactions against the deployed ERC8004PayeeRegistry, PayeeShieldInvoiceEscrow,
 * and official tUSD8 contract (0x456569838f1d43009A91ebA4263147Afd7233483):
 *   1. Registers 3 distinct ERC-8004 Payee NFTs (acme.cloud, eu.taxvault, partner.ops)
 *   2. Issues live epoch-bound KYB attestation on agentId #1 (acme.cloud)
 *   3. Verifies on-chain CoP status outcomes (EXACT_MATCH, CLOSE_MATCH, NO_MATCH, Cyrillic InvalidHandle)
 *   4. Approves tUSD8 & creates Invoice #1 (INSTANT, 1.250003 tUSD8, 85%/10%/5% dust-free 3-way split)
 *   5. Proves BEC/spoof attempt hard-reverts on-chain with 0 tUSD8 moved
 *   6. Executes live CoP-gated payInvoice() settling 1.250003 tUSD8 across 3 legs with 0 wei dust
 *   7. Leaves Invoice #2 OPEN (0.500000 tUSD8, 30d expiry) so judges can inspect preflightCheck() live
 *   8. Saves all public TX hashes & receipts into deployments/aevum-44005.json (ZERO secrets)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { ethers } from "ethers";

if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
  try {
    const undici = await import("undici");
    if (undici?.EnvHttpProxyAgent && undici?.setGlobalDispatcher) {
      undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent());
    }
  } catch {
    // Fallback to direct connection
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(rootDir, ".env") });

const manifestPath = path.join(rootDir, "deployments", "aevum-44005.json");
if (!fs.existsSync(manifestPath)) {
  console.error("ERROR: deployments/aevum-44005.json not found. Run 'npm run deploy:aevum' first.");
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "";
if (!/^0x[0-9a-fA-F]{64}$/.test(PRIVATE_KEY)) {
  console.error("ERROR: DEPLOYER_PRIVATE_KEY missing in local gitignored .env.");
  process.exit(1);
}

const RPC_URL = manifest.rpcUrl || "https://rpc-test.qday.info";
const EXPLORER = manifest.explorerUrl || "https://explorer-test.qday.info";
const REGISTRY_ADDR = manifest.contracts.ERC8004PayeeRegistry.address;
const ESCROW_ADDR = manifest.contracts.PayeeShieldInvoiceEscrow.address;
const TUSD8_ADDR = manifest.tUSD8;

const loadAbi = (rel, name) =>
  JSON.parse(fs.readFileSync(path.join(rootDir, "artifacts", "contracts", rel, `${name}.json`), "utf8")).abi;

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)"
];

const hash = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL, manifest.chainId, { staticNetwork: true });
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  const registry = new ethers.Contract(REGISTRY_ADDR, loadAbi("ERC8004PayeeRegistry.sol", "ERC8004PayeeRegistry"), wallet);
  const escrow = new ethers.Contract(ESCROW_ADDR, loadAbi("PayeeShieldInvoiceEscrow.sol", "PayeeShieldInvoiceEscrow"), wallet);
  const tusd8 = new ethers.Contract(TUSD8_ADDR, ERC20_ABI, wallet);

  console.log("=== PayeeShield Live On-Chain E2E Proof (QDay Aevum 44005) ===");
  console.log("Public Wallet :", wallet.address);
  console.log("Registry      :", REGISTRY_ADDR);
  console.log("Escrow        :", ESCROW_ADDR);
  console.log("Official tUSD8:", TUSD8_ADDR);

  const startQday = await provider.getBalance(wallet.address);
  const startTusd8 = await tusd8.balanceOf(wallet.address);
  console.log(`Start Balances: ${ethers.formatEther(startQday)} tQDAY | ${ethers.formatUnits(startTusd8, 6)} tUSD8`);

  const txs = {};
  const legalMerchant = hash("Acme Cloud Infrastructure Ltd (SG-2026-8841)");
  const legalTax = hash("EU VAT Escrow Vault AG (DE-2026-4410)");
  const legalAffiliate = hash("Partner Ops Solutions Inc (US-2026-9912)");

  // 1. Register 3 ERC-8004 Payee Identities
  console.log("\n[1/7] Registering 3 ERC-8004 Payee Identities...");
  const r1 = await (await registry.registerPayee("Acme.Cloud", legalMerchant, "ipfs://payeeshield-acme-8004.json", [])).wait();
  txs.registerMerchant = { hash: r1.hash, blockNumber: r1.blockNumber, explorerUrl: `${EXPLORER}/tx/${r1.hash}` };
  console.log("  Agent #1 (acme.cloud)  :", r1.hash);

  const r2 = await (await registry.registerPayee("eu.taxvault", legalTax, "ipfs://payeeshield-tax-8004.json", [])).wait();
  txs.registerTaxVault = { hash: r2.hash, blockNumber: r2.blockNumber, explorerUrl: `${EXPLORER}/tx/${r2.hash}` };
  console.log("  Agent #2 (eu.taxvault) :", r2.hash);

  const r3 = await (await registry.registerPayee("partner.ops", legalAffiliate, "ipfs://payeeshield-partner-8004.json", [])).wait();
  txs.registerAffiliate = { hash: r3.hash, blockNumber: r3.blockNumber, explorerUrl: `${EXPLORER}/tx/${r3.hash}` };
  console.log("  Agent #3 (partner.ops) :", r3.hash);

  // 2. Issue live KYB Attestation on Agent #1
  console.log("\n[2/7] Issuing KYB Attestation on Agent #1...");
  const attTx = await (await registry.issueAttestation(1n, hash("AEVUM_KYB_V1"), hash("ipfs://aevum-kyb-acme-2026"), 0)).wait();
  txs.issueKybAttestation = { hash: attTx.hash, blockNumber: attTx.blockNumber, explorerUrl: `${EXPLORER}/tx/${attTx.hash}` };
  console.log("  Attestation Tx:", attTx.hash);

  // 3. On-chain read-only CoP verification checks (EXACT_MATCH, CLOSE_MATCH, NO_MATCH, Cyrillic Homoglyph)
  console.log("\n[3/7] Running Live On-Chain CoP Static Verification Checks...");
  const exactRes = await registry.verifyPayeeByHandle("acme.cloud", legalMerchant, wallet.address);
  const closeRes = await registry.verifyPayeeByHandle("acme.cloud", hash("Acme Cloud Holdings Offshore LLC"), wallet.address);
  const noMatchRes = await registry.verifyPayeeByHandle("acrne.cloud", legalMerchant, "0x000000000000000000000000000000000000dEaD");
  let cyrillicRejected = false;
  try {
    await registry.verifyPayeeByHandle("\u0430cme.cloud", legalMerchant, wallet.address);
  } catch {
    cyrillicRejected = true;
  }
  console.log(`  EXACT_MATCH status=${Number(exactRes.status)} attested=${exactRes.isAttested}`);
  console.log(`  CLOSE_MATCH status=${Number(closeRes.status)} | NO_MATCH status=${Number(noMatchRes.status)} | CyrillicRejected=${cyrillicRejected}`);
  if (Number(exactRes.status) !== 1 || !exactRes.isAttested || Number(closeRes.status) !== 2 || Number(noMatchRes.status) !== 0 || !cyrillicRejected) {
    throw new Error("Live on-chain CoP verification invariant failed!");
  }

  // 4. Approve 2.000000 tUSD8 to Escrow
  console.log("\n[4/7] Approving 2.000000 tUSD8 to PayeeShieldInvoiceEscrow...");
  const appTx = await (await tusd8.approve(ESCROW_ADDR, 2_000_000n)).wait();
  txs.approveTUSD8 = { hash: appTx.hash, blockNumber: appTx.blockNumber, explorerUrl: `${EXPLORER}/tx/${appTx.hash}` };
  console.log("  Approve Tx:", appTx.hash);

  // 5. Create Invoice #1 (INSTANT, 1.250003 tUSD8, dust-free 85% / 10% / 5% split)
  const latestBlock = await provider.getBlock("latest");
  const inv1Amount = 1_250_003n; // 1.250003 tUSD8 (indivisible by 100 -> proves 0 wei dust!)
  console.log("\n[5/7] Creating Live Invoice #1 (1.250003 tUSD8, 85%/10%/5% ERC-8004 verified splits)...");
  const c1Tx = await (
    await escrow.createInvoice(
      {
        payeeAgentId: 1n,
        expectedHandleHash: hash("acme.cloud"),
        expectedLegalHash: legalMerchant,
        expectedPayoutWallet: wallet.address,
        restrictedBuyer: ethers.ZeroAddress,
        amount: inv1Amount,
        expiresAt: latestBlock.timestamp + 86400 * 30,
        disputeWindow: 0,
        mode: 0, // INSTANT
        requireAttestation: true,
        strictNoPendingRotation: true,
        metadataHash: hash("INV-AEVUM-LIVE-001")
      },
      [
        { agentId: 1n, expectedWallet: wallet.address, bps: 8500 },
        { agentId: 2n, expectedWallet: wallet.address, bps: 1000 },
        { agentId: 3n, expectedWallet: wallet.address, bps: 500 }
      ]
    )
  ).wait();
  txs.createInvoice1 = { hash: c1Tx.hash, blockNumber: c1Tx.blockNumber, explorerUrl: `${EXPLORER}/tx/${c1Tx.hash}` };
  console.log("  Create Invoice #1 Tx:", c1Tx.hash);

  // 6. Prove spoofed payout address hard-reverts on-chain (staticCall) + execute real live settlement!
  console.log("\n[6/7] Proving Spoof Block & Executing Live CoP-Gated Settlement of Invoice #1...");
  let spoofRevertVerified = false;
  try {
    await escrow.payInvoice.staticCall(
      1n,
      hash("acme.cloud"),
      legalMerchant,
      "0x000000000000000000000000000000000000dEaD"
    );
  } catch {
    spoofRevertVerified = true;
  }
  if (!spoofRevertVerified) {
    throw new Error("Spoofed payInvoice staticCall did NOT revert!");
  }
  console.log("  Spoofed Wallet Hard-Reverted On-Chain:", spoofRevertVerified);

  const payTx = await (
    await escrow.payInvoice(1n, hash("acme.cloud"), legalMerchant, wallet.address)
  ).wait();
  txs.settleInvoice1 = { hash: payTx.hash, blockNumber: payTx.blockNumber, explorerUrl: `${EXPLORER}/tx/${payTx.hash}` };

  // Decode SplitDistributed & InvoiceSettled logs from live receipt
  const splitEvents = [];
  let receiptHash = null;
  for (const log of payTx.logs) {
    if (log.address.toLowerCase() !== ESCROW_ADDR.toLowerCase()) continue;
    try {
      const parsed = escrow.interface.parseLog(log);
      if (parsed?.name === "SplitDistributed") {
        splitEvents.push({
          agentId: parsed.args.recipientAgentId.toString(),
          recipientWallet: parsed.args.recipientWallet,
          amountBaseUnits: parsed.args.amount.toString(),
          amountTUSD8: ethers.formatUnits(parsed.args.amount, 6),
          bps: Number(parsed.args.bps)
        });
      } else if (parsed?.name === "InvoiceSettled") {
        receiptHash = parsed.args.receiptHash;
      }
    } catch {
      // Ignore unrelated ERC-20 logs
    }
  }
  const escrowDust = await tusd8.balanceOf(ESCROW_ADDR);
  console.log("  Settle Invoice #1 Tx:", payTx.hash);
  console.log("  Splits Settled      :", JSON.stringify(splitEvents));
  console.log("  Escrow Dust (wei)   :", escrowDust.toString());
  console.log("  Receipt Hash        :", receiptHash);
  if (escrowDust !== 0n || splitEvents.length !== 3 || !receiptHash) {
    throw new Error("Live settlement verification failed!");
  }

  // 7. Create Invoice #2 (OPEN, 0.500000 tUSD8, 30-day expiry) so judges can inspect preflightCheck live!
  console.log("\n[7/7] Creating Open Showcase Invoice #2 (0.500000 tUSD8, 30d expiry) for Judge Inspection...");
  const c2Tx = await (
    await escrow.createInvoice(
      {
        payeeAgentId: 1n,
        expectedHandleHash: hash("acme.cloud"),
        expectedLegalHash: legalMerchant,
        expectedPayoutWallet: wallet.address,
        restrictedBuyer: ethers.ZeroAddress,
        amount: 500_000n,
        expiresAt: latestBlock.timestamp + 86400 * 30,
        disputeWindow: 3600,
        mode: 1, // MILESTONE_ESCROW
        requireAttestation: true,
        strictNoPendingRotation: true,
        metadataHash: hash("INV-AEVUM-LIVE-002-OPEN")
      },
      [
        { agentId: 1n, expectedWallet: wallet.address, bps: 8500 },
        { agentId: 2n, expectedWallet: wallet.address, bps: 1000 },
        { agentId: 3n, expectedWallet: wallet.address, bps: 500 }
      ]
    )
  ).wait();
  txs.createOpenInvoice2 = { hash: c2Tx.hash, blockNumber: c2Tx.blockNumber, explorerUrl: `${EXPLORER}/tx/${c2Tx.hash}` };
  const [payableNow, , reason] = await escrow.preflightCheck(2n);
  console.log(`  Open Invoice #2 Tx: ${c2Tx.hash} | preflightCheck=${payableNow} (${reason})`);

  const endQday = await provider.getBalance(wallet.address);
  const endTusd8 = await tusd8.balanceOf(wallet.address);
  console.log(`\nEnd Balances  : ${ethers.formatEther(endQday)} tQDAY | ${ethers.formatUnits(endTusd8, 6)} tUSD8`);

  manifest.liveProof = {
    verifiedAt: new Date().toISOString(),
    agentsRegistered: [
      { agentId: 1, handle: "acme.cloud", kybAttested: true, payoutWallet: wallet.address },
      { agentId: 2, handle: "eu.taxvault", kybAttested: false, payoutWallet: wallet.address },
      { agentId: 3, handle: "partner.ops", kybAttested: false, payoutWallet: wallet.address }
    ],
    copStaticChecks: {
      exactMatchStatus: Number(exactRes.status),
      closeMatchStatus: Number(closeRes.status),
      noMatchStatus: Number(noMatchRes.status),
      cyrillicHomoglyphRejected: cyrillicRejected,
      spoofedPayoutRevertVerified: spoofRevertVerified
    },
    settledInvoice1: {
      invoiceId: 1,
      amountBaseUnits: inv1Amount.toString(),
      amountTUSD8: ethers.formatUnits(inv1Amount, 6),
      splits: splitEvents,
      escrowDustBaseUnits: escrowDust.toString(),
      receiptHash
    },
    openShowcaseInvoice2: {
      invoiceId: 2,
      mode: "MILESTONE_ESCROW",
      amountTUSD8: "0.5",
      preflightPayableNow: payableNow,
      preflightReason: reason
    },
    remainingBalances: {
      tQDAY: ethers.formatEther(endQday),
      tUSD8: ethers.formatUnits(endTusd8, 6)
    },
    transactions: txs
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log("\nUpdated deployments/aevum-44005.json with complete liveProof manifest!");
}

main().catch((err) => {
  console.error("Live verification failed:", err?.shortMessage || err?.message || err);
  process.exit(1);
});
