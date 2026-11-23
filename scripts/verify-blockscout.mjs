#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const manifestPath = path.join(rootDir, "deployments", "aevum-44005.json");

if (!fs.existsSync(manifestPath)) {
  console.error("No deployments/aevum-44005.json found. Run 'npm run deploy:aevum' first after funding your deployer.");
  process.exit(1);
}

const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const regAddr = m.contracts.ERC8004PayeeRegistry.address;
const escAddr = m.contracts.PayeeShieldInvoiceEscrow.address;
const cooldown = process.env.ROTATION_COOLDOWN_SECONDS || "3600";

console.log("Verifying ERC8004PayeeRegistry on Aevum Blockscout...");
execSync(`npx hardhat verify --network aevumTestnet ${regAddr} ${m.deployer} ${cooldown}`, {
  cwd: rootDir,
  stdio: "inherit"
});

console.log("Verifying PayeeShieldInvoiceEscrow on Aevum Blockscout...");
execSync(`npx hardhat verify --network aevumTestnet ${escAddr} ${m.tUSD8} ${regAddr} ${m.deployer} ${m.arbiter}`, {
  cwd: rootDir,
  stdio: "inherit"
});
