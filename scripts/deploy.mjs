#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { ethers } from "ethers";

// Respect HTTP_PROXY / HTTPS_PROXY transparently when Node's native fetch runs behind a local proxy
if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
  try {
    const undici = await import("undici");
    if (undici?.EnvHttpProxyAgent && undici?.setGlobalDispatcher) {
      undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent());
    }
  } catch {
    // Fallback to direct connection if undici is unavailable
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(rootDir, ".env") });

const RPC_URL = process.env.AEVUM_RPC_URL || "https://rpc-test.qday.info";
const EXPECTED_CHAIN_ID = BigInt(process.env.AEVUM_CHAIN_ID || "44005");
const EXPLORER_URL = process.env.AEVUM_EXPLORER_URL || "https://explorer-test.qday.info";
const TUSD8_ADDRESS = process.env.TUSD8_ADDRESS || "0x456569838f1d43009A91ebA4263147Afd7233483";
const ROTATION_COOLDOWN = BigInt(process.env.ROTATION_COOLDOWN_SECONDS || "3600");
const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "";

function loadArtifact(contractRelPath, name) {
  const fullPath = path.join(rootDir, "artifacts", "contracts", contractRelPath, `${name}.json`);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Missing compiled artifact at ${fullPath}. Run 'npm run compile' first.`);
  }
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

async function main() {
  if (!/^0x[0-9a-fA-F]{64}$/.test(PRIVATE_KEY)) {
    console.error("ERROR: DEPLOYER_PRIVATE_KEY not set in uncommitted .env.");
    console.error("Run 'npm run wallet:new' to generate a local gitignored deployer key without printing secrets.");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL, Number(EXPECTED_CHAIN_ID), { staticNetwork: true });
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const arbiter = ethers.isAddress(process.env.ARBITER_ADDRESS || "") ? process.env.ARBITER_ADDRESS : wallet.address;

  console.log("=== PayeeShield -> QDay Aevum Testnet (Chain ID 44005) Deployment ===");
  console.log("RPC URL          :", RPC_URL);
  console.log("Public Deployer  :", wallet.address);
  console.log("Arbiter Address  :", arbiter);
  console.log("Official tUSD8   :", TUSD8_ADDRESS);

  const network = await provider.getNetwork();
  if (network.chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`Unexpected chainId ${network.chainId}; expected ${EXPECTED_CHAIN_ID}`);
  }

  const tusd8Code = await provider.getCode(TUSD8_ADDRESS);
  if (!tusd8Code || tusd8Code === "0x") {
    throw new Error(`tUSD8 contract not found at ${TUSD8_ADDRESS} on chainId ${network.chainId}`);
  }

  const balance = await provider.getBalance(wallet.address);
  console.log("Deployer Balance :", ethers.formatEther(balance), "tQDAY");

  if (balance === 0n) {
    console.log("");
    console.log("DEPLOYMENT_BLOCKED_UNFUNDED_GAS:");
    console.log(`  Public deployer ${wallet.address} currently holds 0 tQDAY on QDay Aevum Testnet (44005).`);
    console.log("  The official faucet (https://faucet.qday.info) requires human Cloudflare Turnstile / reCAPTCHA verification.");
    console.log("  Action: Fund this public address via https://faucet.qday.info or Discord (https://discord.gg/bYPhjmrSfK),");
    console.log("          then re-run: npm run deploy:aevum");
    process.exit(2);
  }

  const registryArtifact = loadArtifact("ERC8004PayeeRegistry.sol", "ERC8004PayeeRegistry");
  const escrowArtifact = loadArtifact("PayeeShieldInvoiceEscrow.sol", "PayeeShieldInvoiceEscrow");

  console.log("\n[1/2] Deploying ERC8004PayeeRegistry...");
  const RegistryFactory = new ethers.ContractFactory(registryArtifact.abi, registryArtifact.bytecode, wallet);
  const registry = await RegistryFactory.deploy(wallet.address, ROTATION_COOLDOWN);
  const regTx = registry.deploymentTransaction();
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  console.log("  ERC8004PayeeRegistry:", registryAddr);
  console.log("  Tx:", `${EXPLORER_URL}/tx/${regTx.hash}`);

  console.log("\n[2/2] Deploying PayeeShieldInvoiceEscrow...");
  const EscrowFactory = new ethers.ContractFactory(escrowArtifact.abi, escrowArtifact.bytecode, wallet);
  const escrow = await EscrowFactory.deploy(TUSD8_ADDRESS, registryAddr, wallet.address, arbiter);
  const escTx = escrow.deploymentTransaction();
  await escrow.waitForDeployment();
  const escrowAddr = await escrow.getAddress();
  console.log("  PayeeShieldInvoiceEscrow:", escrowAddr);
  console.log("  Tx:", `${EXPLORER_URL}/tx/${escTx.hash}`);

  const deployDir = path.join(rootDir, "deployments");
  fs.mkdirSync(deployDir, { recursive: true });
  const record = {
    network: "QDay Aevum Testnet",
    chainId: Number(EXPECTED_CHAIN_ID),
    rpcUrl: RPC_URL,
    explorerUrl: EXPLORER_URL,
    deployedAt: new Date().toISOString(),
    deployer: wallet.address,
    arbiter,
    tUSD8: TUSD8_ADDRESS,
    contracts: {
      ERC8004PayeeRegistry: {
        address: registryAddr,
        txHash: regTx.hash,
        explorerUrl: `${EXPLORER_URL}/address/${registryAddr}`
      },
      PayeeShieldInvoiceEscrow: {
        address: escrowAddr,
        txHash: escTx.hash,
        explorerUrl: `${EXPLORER_URL}/address/${escrowAddr}`
      }
    }
  };
  fs.writeFileSync(path.join(deployDir, "aevum-44005.json"), JSON.stringify(record, null, 2));

  // Sync live deployed addresses into web/src/config/aevum.js
  const webCfgPath = path.join(rootDir, "web", "src", "config", "aevum.js");
  if (fs.existsSync(webCfgPath)) {
    let cfg = fs.readFileSync(webCfgPath, "utf8");
    cfg = cfg.replace(/registry:\s*"[^"]*"/, `registry: "${registryAddr}"`);
    cfg = cfg.replace(/escrow:\s*"[^"]*"/, `escrow: "${escrowAddr}"`);
    fs.writeFileSync(webCfgPath, cfg, "utf8");
  }

  console.log("\nSaved public deployment manifest -> deployments/aevum-44005.json");
  console.log("Synced deployed addresses into web/src/config/aevum.js (re-run 'npm run web:build' to bundle).");
}

main().catch((err) => {
  console.error("Deployment error:", err?.shortMessage || err?.message || err);
  process.exit(1);
});
