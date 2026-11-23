const { ethers } = require("hardhat");

async function main() {
  const [admin, arbiter, merchant, taxVault, affiliate, buyer, attacker] = await ethers.getSigners();

  const MockTUSD8 = await ethers.getContractFactory("MockTUSD8");
  const tusd8 = await MockTUSD8.deploy();
  await tusd8.waitForDeployment();

  const Registry = await ethers.getContractFactory("ERC8004PayeeRegistry");
  const registry = await Registry.deploy(admin.address, 3600);
  await registry.waitForDeployment();

  const Escrow = await ethers.getContractFactory("PayeeShieldInvoiceEscrow");
  const escrow = await Escrow.deploy(
    await tusd8.getAddress(),
    await registry.getAddress(),
    admin.address,
    arbiter.address
  );
  await escrow.waitForDeployment();

  const hash = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
  const legalMerchant = hash("Acme Cloud Infrastructure Ltd (SG-2026-8841)");

  await (await registry.connect(merchant).registerPayee("Acme.Cloud", legalMerchant, "ipfs://acme-8004.json", [])).wait();
  await (await registry.connect(taxVault).registerPayee("eu.taxvault", hash("EU VAT Vault AG"), "ipfs://tax.json", [])).wait();
  await (await registry.connect(affiliate).registerPayee("partner.ops", hash("Partner Ops Inc"), "ipfs://aff.json", [])).wait();
  await (await registry.connect(admin).issueAttestation(1n, hash("AEVUM_KYB_V1"), hash("ipfs://kyb"), 0)).wait();

  const amount = 12_500_000_003n; // 12,500.000003 tUSD8
  await (await tusd8.mint(buyer.address, amount * 2n)).wait();
  await (await tusd8.connect(buyer).approve(await escrow.getAddress(), ethers.MaxUint256)).wait();

  const latest = await ethers.provider.getBlock("latest");
  await (
    await escrow.connect(merchant).createInvoice(
      {
        payeeAgentId: 1n,
        expectedHandleHash: hash("acme.cloud"),
        expectedLegalHash: legalMerchant,
        expectedPayoutWallet: merchant.address,
        restrictedBuyer: ethers.ZeroAddress,
        amount,
        expiresAt: latest.timestamp + 3600,
        disputeWindow: 0,
        mode: 0,
        requireAttestation: true,
        strictNoPendingRotation: true,
        metadataHash: hash("INV-LOCAL-PROOF-01")
      },
      [
        { agentId: 1n, expectedWallet: merchant.address, bps: 8500 },
        { agentId: 2n, expectedWallet: taxVault.address, bps: 1000 },
        { agentId: 3n, expectedWallet: affiliate.address, bps: 500 }
      ]
    )
  ).wait();

  // Verify spoof attempt reverts with 0 wei moved
  let spoofBlocked = false;
  try {
    await escrow.connect(buyer).payInvoice(1n, hash("acme.cloud"), legalMerchant, attacker.address);
  } catch {
    spoofBlocked = true;
  }

  // Execute valid CoP-verified 3-way split settlement
  await (await escrow.connect(buyer).payInvoice(1n, hash("acme.cloud"), legalMerchant, merchant.address)).wait();

  const receiptHash = await escrow.getReceipt(1n);
  console.log("=== Local Hardhat (Chain ID 44005) End-to-End Proof ===");
  console.log("MockTUSD8               :", await tusd8.getAddress());
  console.log("ERC8004PayeeRegistry    :", await registry.getAddress());
  console.log("PayeeShieldInvoiceEscrow:", await escrow.getAddress());
  console.log("Spoofed Payout Blocked  :", spoofBlocked);
  console.log("Merchant Received (6dp) :", (await tusd8.balanceOf(merchant.address)).toString());
  console.log("TaxVault Received (6dp) :", (await tusd8.balanceOf(taxVault.address)).toString());
  console.log("Affiliate Received (6dp):", (await tusd8.balanceOf(affiliate.address)).toString());
  console.log("Escrow Dust Remaining   :", (await tusd8.balanceOf(await escrow.getAddress())).toString());
  console.log("Deterministic Receipt   :", receiptHash);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
