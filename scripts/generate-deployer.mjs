#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Wallet } from "ethers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const envPath = path.join(rootDir, ".env");
const examplePath = path.join(rootDir, ".env.example");

if (fs.existsSync(envPath)) {
  const existing = fs.readFileSync(envPath, "utf8");
  const match = existing.match(/^DEPLOYER_PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m);
  if (match) {
    const existingWallet = new Wallet(match[1]);
    console.log("Existing uncommitted .env deployer wallet found (private key NOT printed).");
    console.log("Public Deployer Address:", existingWallet.address);
    console.log("Fund with tQDAY gas & tUSD8 at: https://faucet.qday.info (requires human Turnstile/reCAPTCHA)");
    console.log("Backup Discord faucet: https://discord.gg/bYPhjmrSfK");
    process.exit(0);
  }
}

const wallet = Wallet.createRandom();
let template = fs.existsSync(examplePath)
  ? fs.readFileSync(examplePath, "utf8")
  : "AEVUM_RPC_URL=https://rpc-test.qday.info\nAEVUM_CHAIN_ID=44005\nTUSD8_ADDRESS=0x456569838f1d43009A91ebA4263147Afd7233483\nDEPLOYER_PRIVATE_KEY=\n";

if (/^DEPLOYER_PRIVATE_KEY=.*$/m.test(template)) {
  template = template.replace(/^DEPLOYER_PRIVATE_KEY=.*$/m, `DEPLOYER_PRIVATE_KEY=${wallet.privateKey}`);
} else {
  template += `\nDEPLOYER_PRIVATE_KEY=${wallet.privateKey}\n`;
}

fs.writeFileSync(envPath, template, { encoding: "utf8", mode: 0o600 });

console.log("Generated fresh deployer key and wrote ONLY to gitignored .env (private key NOT printed).");
console.log("Public Deployer Address:", wallet.address);
console.log("Next steps:");
console.log("  1. Claim tQDAY gas (and optional tUSD8) at https://faucet.qday.info (Cloudflare Turnstile / reCAPTCHA)");
console.log("     or via QDay Discord: https://discord.gg/bYPhjmrSfK");
console.log("  2. Deploy contracts to QDay Aevum Testnet (Chain ID 44005): npm run deploy:aevum");
