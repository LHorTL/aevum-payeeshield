const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("PayeeShield — ERC-8004 Confirmation-of-Payee & tUSD8 Invoice Escrow", function () {
  const COOLDOWN = 3600n; // 1 hour rotation cooldown
  const ONE_TUSD8 = 1_000_000n; // 6 decimals (matches live Aevum tUSD8)
  const SCHEMA_KYB = ethers.keccak256(ethers.toUtf8Bytes("AEVUM_KYB_V1"));
  const EVIDENCE_HASH = ethers.keccak256(ethers.toUtf8Bytes("ipfs://bafy-kyb-evidence-01"));

  const CoPStatus = {
    UNREGISTERED: 0n,
    EXACT_MATCH: 1n,
    CLOSE_MATCH_WARNING: 2n,
    NO_MATCH: 3n,
    PAYEE_REVOKED: 4n,
    WALLET_ROTATION_PENDING: 5n
  };

  const SettlementMode = {
    INSTANT: 0,
    MILESTONE_ESCROW: 1
  };

  const InvoiceStatus = {
    NONE: 0n,
    OPEN: 1n,
    FUNDED: 2n,
    SETTLED: 3n,
    DISPUTED: 4n,
    REFUNDED: 5n,
    CANCELLED: 6n,
    EXPIRED: 7n
  };

  function hashStr(s) {
    return ethers.keccak256(ethers.toUtf8Bytes(s));
  }

  async function signSetAgentWallet(registry, signer, agentId, newWallet, nonce, deadline) {
    const net = await ethers.provider.getNetwork();
    const domain = {
      name: "PayeeShieldERC8004Registry",
      version: "1",
      chainId: net.chainId,
      verifyingContract: await registry.getAddress()
    };
    const types = {
      SetAgentWallet: [
        { name: "agentId", type: "uint256" },
        { name: "newWallet", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" }
      ]
    };
    return signer.signTypedData(domain, types, { agentId, newWallet, nonce, deadline });
  }

  async function signCoPReceipt(registry, signer, { agentId, handleHash, legalEntityHash, payoutWallet, invoiceSalt, nonce, deadline }) {
    const net = await ethers.provider.getNetwork();
    const domain = {
      name: "PayeeShieldERC8004Registry",
      version: "1",
      chainId: net.chainId,
      verifyingContract: await registry.getAddress()
    };
    const types = {
      CoPReceipt: [
        { name: "agentId", type: "uint256" },
        { name: "handleHash", type: "bytes32" },
        { name: "legalEntityHash", type: "bytes32" },
        { name: "payoutWallet", type: "address" },
        { name: "invoiceSalt", type: "bytes32" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" }
      ]
    };
    return signer.signTypedData(domain, types, {
      agentId,
      handleHash,
      legalEntityHash,
      payoutWallet,
      invoiceSalt,
      nonce,
      deadline
    });
  }

  async function deployFixture() {
    const signers = await ethers.getSigners();
    const [admin, arbiter, attester, merchant, taxVault, affiliate, buyer, attacker, rotatedWallet, extra1, extra2, extra3, extra4, extra5] = signers;

    const MockTUSD8 = await ethers.getContractFactory("MockTUSD8");
    const tusd8 = await MockTUSD8.deploy();

    const Registry = await ethers.getContractFactory("ERC8004PayeeRegistry");
    const registry = await Registry.deploy(admin.address, COOLDOWN);

    const ATTESTER_ROLE = await registry.ATTESTER_ROLE();
    await registry.connect(admin).grantRole(ATTESTER_ROLE, attester.address);

    const Escrow = await ethers.getContractFactory("PayeeShieldInvoiceEscrow");
    const escrow = await Escrow.deploy(
      await tusd8.getAddress(),
      await registry.getAddress(),
      admin.address,
      arbiter.address
    );

    // Register 3 verified commercial payees
    const merchantHandle = "acme.cloud";
    const merchantLegal = hashStr("Acme Cloud Infrastructure Ltd (SG-2026-8841)");
    await registry.connect(merchant).registerPayee(
      "Acme.Cloud", // mixed case -> normalized to acme.cloud
      merchantLegal,
      "ipfs://bafy-acme-agent-8004.json",
      [{ metadataKey: "category", metadataValue: ethers.toUtf8Bytes("B2B_SAAS") }]
    ); // agentId = 1

    const taxHandle = "eu.taxvault";
    const taxLegal = hashStr("EU VAT Settlement Vault AG");
    await registry.connect(taxVault).registerPayee(taxHandle, taxLegal, "ipfs://bafy-taxvault.json", []); // agentId = 2

    const affHandle = "partner.ops";
    const affLegal = hashStr("Partner Ops Network Inc");
    await registry.connect(affiliate).registerPayee(affHandle, affLegal, "ipfs://bafy-affiliate.json", []); // agentId = 3

    // Issue KYB attestation for merchant
    await registry.connect(attester).issueAttestation(1n, SCHEMA_KYB, EVIDENCE_HASH, 0);

    // Fund buyer with 2,000,000 tUSD8
    await tusd8.mint(buyer.address, 2_000_000n * ONE_TUSD8);
    await tusd8.connect(buyer).approve(await escrow.getAddress(), ethers.MaxUint256);

    return {
      tusd8,
      registry,
      escrow,
      admin,
      arbiter,
      attester,
      merchant,
      taxVault,
      affiliate,
      buyer,
      attacker,
      rotatedWallet,
      extras: [extra1, extra2, extra3, extra4, extra5],
      merchantHandle,
      merchantHandleHash: hashStr(merchantHandle),
      merchantLegal,
      taxHandleHash: hashStr(taxHandle),
      affHandleHash: hashStr(affHandle)
    };
  }

  // ===========================================================================
  // 1. ERC-8004 Identity Registry Compliance & Homoglyph Defense
  // ===========================================================================
  describe("1. ERC-8004 Identity Registry & Homoglyph Defense", function () {
    it("1.1 supports bare ERC-8004 register(agentURI) & register(agentURI, metadata)", async function () {
      const { registry, attacker } = await deployFixture();
      const tx1 = await registry.connect(attacker)["register(string)"]("ipfs://agent-bare.json");
      await tx1.wait();
      const id1 = await registry.totalAgents();
      expect(await registry.ownerOf(id1)).to.equal(attacker.address);
      expect(await registry.tokenURI(id1)).to.equal("ipfs://agent-bare.json");
      expect(await registry.getAgentWallet(id1)).to.equal(attacker.address);

      const tx2 = await registry.connect(attacker)["register(string,(string,bytes)[])"](
        "ipfs://agent-meta.json",
        [{ metadataKey: "mcpEndpoint", metadataValue: ethers.toUtf8Bytes("https://agent.example/mcp") }]
      );
      await tx2.wait();
      const id2 = await registry.totalAgents();
      const stored = await registry.getMetadata(id2, "mcpEndpoint");
      expect(ethers.toUtf8String(stored)).to.equal("https://agent.example/mcp");
      // Reserved agentWallet readable via getMetadata
      const encodedWallet = await registry.getMetadata(id2, "agentWallet");
      const [decodedWallet] = ethers.AbiCoder.defaultAbiCoder().decode(["address"], encodedWallet);
      expect(decodedWallet).to.equal(attacker.address);
    });

    it("1.2 blocks writing reserved metadata key 'agentWallet' per ERC-8004", async function () {
      const { registry, merchant, attacker } = await deployFixture();
      await expect(
        registry.connect(merchant).setMetadata(1n, "agentWallet", ethers.AbiCoder.defaultAbiCoder().encode(["address"], [attacker.address]))
      ).to.be.revertedWithCustomError(registry, "ReservedMetadataKey");

      await expect(
        registry.connect(attacker)["register(string,(string,bytes)[])"](
          "ipfs://bad.json",
          [{ metadataKey: "agentWallet", metadataValue: "0x1234" }]
        )
      ).to.be.revertedWithCustomError(registry, "ReservedMetadataKey");
    });

    it("1.3 normalizes ASCII handles and rejects duplicates & Unicode/Cyrillic homoglyphs", async function () {
      const { registry, merchant, attacker, merchantHandleHash } = await deployFixture();
      const profile = await registry.getPayeeProfile(1n);
      expect(profile.handle).to.equal("acme.cloud");
      expect(profile.handleHash).to.equal(merchantHandleHash);
      expect(await registry.agentIdByHandleHash(merchantHandleHash)).to.equal(1n);

      // Case-insensitive duplicate blocked
      await expect(
        registry.connect(attacker).registerPayee("ACME.CLOUD", hashStr("Fake Corp"), "ipfs://x", [])
      ).to.be.revertedWithCustomError(registry, "HandleAlreadyRegistered");

      // Cyrillic 'а' (U+0430) homoglyph lookalike blocked at Solidity level
      await expect(
        registry.connect(attacker).registerPayee("\u0430cme.cloud", hashStr("Spoof Corp"), "ipfs://x", [])
      ).to.be.revertedWithCustomError(registry, "InvalidHandle");

      // Malformed handles blocked
      for (const bad of ["ab", ".acme.cloud", "acme.cloud.", "acme..cloud", "acme cloud", "acme$pay"]) {
        await expect(
          registry.connect(merchant).registerPayee(bad, hashStr("X"), "ipfs://x", [])
        ).to.be.revertedWithCustomError(registry, "InvalidHandle");
      }
    });

    it("1.4 enforces ERC-8004 transfer safety: NFT transfer clears payoutWallet & pending rotation", async function () {
      const { registry, merchant, rotatedWallet, attacker } = await deployFixture();
      const now = BigInt(await time.latest());
      const sig = await signSetAgentWallet(registry, rotatedWallet, 1n, rotatedWallet.address, 0n, now + 600n);
      await registry.connect(merchant).setAgentWallet(1n, rotatedWallet.address, now + 600n, sig);
      expect((await registry.getPayeeProfile(1n)).pendingPayoutWallet).to.equal(rotatedWallet.address);

      // Transfer ERC-721 NFT to new owner
      await registry.connect(merchant).transferFrom(merchant.address, attacker.address, 1n);
      expect(await registry.getAgentWallet(1n)).to.equal(ethers.ZeroAddress);
      expect((await registry.getPayeeProfile(1n)).pendingPayoutWallet).to.equal(ethers.ZeroAddress);

      // New owner binds fresh wallet immediately once wallet == address(0) with valid EIP-712 sig
      const nonce = await registry.walletNonces(1n);
      const sig2 = await signSetAgentWallet(registry, attacker, 1n, attacker.address, nonce, now + 1200n);
      await registry.connect(attacker).setAgentWallet(1n, attacker.address, now + 1200n, sig2);
      expect(await registry.getAgentWallet(1n)).to.equal(attacker.address);
    });

    it("1.5 rejects spoofed, expired, and replayed EIP-712 setAgentWallet signatures", async function () {
      const { registry, merchant, rotatedWallet, attacker } = await deployFixture();
      const now = BigInt(await time.latest());

      // Spoofed signature (attacker signs instead of rotatedWallet)
      const spoofSig = await signSetAgentWallet(registry, attacker, 1n, rotatedWallet.address, 0n, now + 600n);
      await expect(
        registry.connect(merchant).setAgentWallet(1n, rotatedWallet.address, now + 600n, spoofSig)
      ).to.be.revertedWithCustomError(registry, "InvalidWalletSignature");

      // Expired deadline
      const expiredSig = await signSetAgentWallet(registry, rotatedWallet, 1n, rotatedWallet.address, 0n, now - 1n);
      await expect(
        registry.connect(merchant).setAgentWallet(1n, rotatedWallet.address, now - 1n, expiredSig)
      ).to.be.revertedWithCustomError(registry, "SignatureExpired");

      // Valid proposal consumes nonce 0
      const validSig = await signSetAgentWallet(registry, rotatedWallet, 1n, rotatedWallet.address, 0n, now + 600n);
      await registry.connect(merchant).setAgentWallet(1n, rotatedWallet.address, now + 600n, validSig);

      // Replay of same signature fails because walletNonces[1] is now 1
      await expect(
        registry.connect(merchant).setAgentWallet(1n, rotatedWallet.address, now + 600n, validSig)
      ).to.be.revertedWithCustomError(registry, "InvalidWalletSignature");
    });

    it("1.6 enforces timelocked wallet rotation cooldown and allows guardian cancellation", async function () {
      const { registry, admin, merchant, rotatedWallet } = await deployFixture();
      const now = BigInt(await time.latest());
      const sig = await signSetAgentWallet(registry, rotatedWallet, 1n, rotatedWallet.address, 0n, now + 600n);
      await registry.connect(merchant).setAgentWallet(1n, rotatedWallet.address, now + 600n, sig);

      // Cannot finalize before cooldown
      await expect(
        registry.connect(merchant).finalizePayoutWalletRotation(1n)
      ).to.be.revertedWithCustomError(registry, "RotationCooldownActive");

      // Guardian cancels suspicious rotation
      await registry.connect(admin).cancelPayoutWalletRotation(1n);
      expect((await registry.getPayeeProfile(1n)).pendingPayoutWallet).to.equal(ethers.ZeroAddress);

      // Re-propose with nonce 1 and finalize after cooldown
      const sig2 = await signSetAgentWallet(registry, rotatedWallet, 1n, rotatedWallet.address, 1n, now + 1200n);
      await registry.connect(merchant).setAgentWallet(1n, rotatedWallet.address, now + 1200n, sig2);
      await time.increase(COOLDOWN + 1n);
      await registry.connect(merchant).finalizePayoutWalletRotation(1n);
      expect(await registry.getAgentWallet(1n)).to.equal(rotatedWallet.address);
    });

    it("1.7 manages KYB attestation expiry, revocation, and emergency payee revocation", async function () {
      const { registry, admin, attester } = await deployFixture();
      expect(await registry.hasValidAttestation(1n)).to.equal(true);
      const list = await registry.getAttestations(1n);
      expect(list.length).to.equal(1);

      await registry.connect(attester).revokeAttestation(1n, list[0].attestationId);
      expect(await registry.hasValidAttestation(1n)).to.equal(false);

      // Timed attestation expires automatically
      const now = BigInt(await time.latest());
      await registry.connect(attester).issueAttestation(1n, SCHEMA_KYB, EVIDENCE_HASH, now + 100n);
      expect(await registry.hasValidAttestation(1n)).to.equal(true);
      await time.increase(120n);
      expect(await registry.hasValidAttestation(1n)).to.equal(false);

      // Emergency revocation zeroes active wallet permanently
      await registry.connect(admin).revokePayee(1n, hashStr("COMPROMISED_KEY"));
      expect(await registry.isPayeeRevoked(1n)).to.equal(true);
      expect(await registry.getAgentWallet(1n)).to.equal(ethers.ZeroAddress);
    });
  });

  // ===========================================================================
  // 2. Confirmation-of-Payee (CoP) Pre-Flight & On-Chain Gate
  // ===========================================================================
  describe("2. Confirmation-of-Payee Pre-Flight & Settlement Gate", function () {
    it("2.1 classifies EXACT_MATCH, CLOSE_MATCH_WARNING, NO_MATCH, ROTATION_PENDING, REVOKED, UNREGISTERED", async function () {
      const { registry, admin, merchant, attacker, rotatedWallet, merchantLegal } = await deployFixture();

      // EXACT_MATCH
      let r = await registry.verifyPayeeByHandle("acme.cloud", merchantLegal, merchant.address);
      expect(r.status).to.equal(CoPStatus.EXACT_MATCH);
      expect(r.isAttested).to.equal(true);

      // CLOSE_MATCH_WARNING (handle & wallet match, legal entity name differs)
      r = await registry.verifyPayeeByHandle("acme.cloud", hashStr("Acme Cloud Wrong Entity LLC"), merchant.address);
      expect(r.status).to.equal(CoPStatus.CLOSE_MATCH_WARNING);

      // NO_MATCH (spoofed payout address)
      r = await registry.verifyPayeeByHandle("acme.cloud", merchantLegal, attacker.address);
      expect(r.status).to.equal(CoPStatus.NO_MATCH);

      // UNREGISTERED (typosquat lookalike handle)
      r = await registry.verifyPayeeByHandle("acrne.cloud", merchantLegal, attacker.address);
      expect(r.status).to.equal(CoPStatus.UNREGISTERED);

      // WALLET_ROTATION_PENDING
      const now = BigInt(await time.latest());
      const sig = await signSetAgentWallet(registry, rotatedWallet, 1n, rotatedWallet.address, 0n, now + 600n);
      await registry.connect(merchant).setAgentWallet(1n, rotatedWallet.address, now + 600n, sig);
      r = await registry.verifyPayeeByHandle("acme.cloud", merchantLegal, merchant.address);
      expect(r.status).to.equal(CoPStatus.WALLET_ROTATION_PENDING);
      expect(r.hasPendingRotation).to.equal(true);

      // PAYEE_REVOKED
      await registry.connect(admin).revokePayee(1n, hashStr("FRAUD"));
      r = await registry.verifyPayeeByHandle("acme.cloud", merchantLegal, merchant.address);
      expect(r.status).to.equal(CoPStatus.PAYEE_REVOKED);
    });

    it("2.2 settles instant invoice on EXACT_MATCH and emits deterministic receiptHash", async function () {
      const { tusd8, escrow, merchant, buyer, merchantHandleHash, merchantLegal } = await deployFixture();
      const amount = 2500n * ONE_TUSD8;
      const expiresAt = BigInt(await time.latest()) + 3600n;

      await escrow.connect(merchant).createInvoice(
        {
          payeeAgentId: 1n,
          expectedHandleHash: merchantHandleHash,
          expectedLegalHash: merchantLegal,
          expectedPayoutWallet: merchant.address,
          restrictedBuyer: ethers.ZeroAddress,
          amount,
          expiresAt,
          disputeWindow: 0,
          mode: SettlementMode.INSTANT,
          requireAttestation: true,
          strictNoPendingRotation: true,
          metadataHash: hashStr("INV-2026-001")
        },
        [{ agentId: 1n, expectedWallet: merchant.address, bps: 10000 }]
      );

      const pre = await escrow.preflightCheck(1n);
      expect(pre.payableNow).to.equal(true);
      expect(pre.reason).to.equal("EXACT_MATCH_READY");

      const beforeMerchant = await tusd8.balanceOf(merchant.address);
      const tx = await escrow.connect(buyer).payInvoice(1n, merchantHandleHash, merchantLegal, merchant.address);
      await expect(tx).to.emit(escrow, "InvoiceSettled");

      expect(await tusd8.balanceOf(merchant.address)).to.equal(beforeMerchant + amount);
      expect(await tusd8.balanceOf(await escrow.getAddress())).to.equal(0n);

      const inv = await escrow.getInvoice(1n);
      expect(inv.status).to.equal(InvoiceStatus.SETTLED);
      expect(inv.receiptHash).to.not.equal(ethers.ZeroHash);
      expect(await escrow.getReceipt(1n)).to.equal(inv.receiptHash);

      // Double-pay blocked
      await expect(
        escrow.connect(buyer).payInvoice(1n, merchantHandleHash, merchantLegal, merchant.address)
      ).to.be.revertedWithCustomError(escrow, "AlreadySettled");
    });

    it("2.3 blocks UI/MITM substitution when buyer expectations mismatch invoice", async function () {
      const { tusd8, escrow, merchant, buyer, attacker, merchantHandleHash, merchantLegal } = await deployFixture();
      const expiresAt = BigInt(await time.latest()) + 3600n;
      await escrow.connect(merchant).createInvoice(
        {
          payeeAgentId: 1n,
          expectedHandleHash: merchantHandleHash,
          expectedLegalHash: merchantLegal,
          expectedPayoutWallet: merchant.address,
          restrictedBuyer: ethers.ZeroAddress,
          amount: 500n * ONE_TUSD8,
          expiresAt,
          disputeWindow: 0,
          mode: SettlementMode.INSTANT,
          requireAttestation: false,
          strictNoPendingRotation: false,
          metadataHash: hashStr("INV-MITM")
        },
        [{ agentId: 1n, expectedWallet: merchant.address, bps: 10000 }]
      );

      const buyerBefore = await tusd8.balanceOf(buyer.address);
      await expect(
        escrow.connect(buyer).payInvoice(1n, merchantHandleHash, merchantLegal, attacker.address)
      ).to.be.revertedWithCustomError(escrow, "BuyerExpectationMismatch");
      await expect(
        escrow.connect(buyer).payInvoice(1n, hashStr("acrne.cloud"), merchantLegal, merchant.address)
      ).to.be.revertedWithCustomError(escrow, "BuyerExpectationMismatch");
      expect(await tusd8.balanceOf(buyer.address)).to.equal(buyerBefore);
    });

    it("2.4 hard-reverts payment if payee wallet rotated/transferred after invoice issuance", async function () {
      const { registry, escrow, merchant, buyer, attacker, merchantHandleHash, merchantLegal } = await deployFixture();
      const expiresAt = BigInt(await time.latest()) + 3600n;
      await escrow.connect(merchant).createInvoice(
        {
          payeeAgentId: 1n,
          expectedHandleHash: merchantHandleHash,
          expectedLegalHash: merchantLegal,
          expectedPayoutWallet: merchant.address,
          restrictedBuyer: ethers.ZeroAddress,
          amount: 1000n * ONE_TUSD8,
          expiresAt,
          disputeWindow: 0,
          mode: SettlementMode.INSTANT,
          requireAttestation: false,
          strictNoPendingRotation: false,
          metadataHash: hashStr("INV-ROTATED")
        },
        [{ agentId: 1n, expectedWallet: merchant.address, bps: 10000 }]
      );

      // Identity NFT transferred -> agentWallet reset to 0x0
      await registry.connect(merchant).transferFrom(merchant.address, attacker.address, 1n);

      const pre = await escrow.preflightCheck(1n);
      expect(pre.payableNow).to.equal(false);
      expect(pre.reason).to.equal("PAYEE_MISMATCH");

      await expect(
        escrow.connect(buyer).payInvoice(1n, merchantHandleHash, merchantLegal, merchant.address)
      ).to.be.revertedWithCustomError(escrow, "PayeeMismatch").withArgs(CoPStatus.NO_MATCH);
    });

    it("2.5 hard-reverts payment if payee is revoked after invoice issuance (0 wei moves)", async function () {
      const { tusd8, registry, escrow, admin, merchant, buyer, merchantHandleHash, merchantLegal } = await deployFixture();
      const expiresAt = BigInt(await time.latest()) + 3600n;
      await escrow.connect(merchant).createInvoice(
        {
          payeeAgentId: 1n,
          expectedHandleHash: merchantHandleHash,
          expectedLegalHash: merchantLegal,
          expectedPayoutWallet: merchant.address,
          restrictedBuyer: ethers.ZeroAddress,
          amount: 750n * ONE_TUSD8,
          expiresAt,
          disputeWindow: 0,
          mode: SettlementMode.INSTANT,
          requireAttestation: false,
          strictNoPendingRotation: false,
          metadataHash: hashStr("INV-REVOKED")
        },
        [{ agentId: 1n, expectedWallet: merchant.address, bps: 10000 }]
      );

      await registry.connect(admin).revokePayee(1n, hashStr("SANCTIONED_OR_COMPROMISED"));
      const buyerBefore = await tusd8.balanceOf(buyer.address);

      const pre = await escrow.preflightCheck(1n);
      expect(pre.payableNow).to.equal(false);
      expect(pre.reason).to.equal("PAYEE_REVOKED");

      await expect(
        escrow.connect(buyer).payInvoice(1n, merchantHandleHash, merchantLegal, merchant.address)
      ).to.be.revertedWithCustomError(escrow, "PayeeRevoked").withArgs(1n);
      expect(await tusd8.balanceOf(buyer.address)).to.equal(buyerBefore);
    });

    it("2.6 blocks payment under strictNoPendingRotation during key rotation cooldown", async function () {
      const { registry, escrow, merchant, buyer, rotatedWallet, merchantHandleHash, merchantLegal } = await deployFixture();
      const now = BigInt(await time.latest());
      await escrow.connect(merchant).createInvoice(
        {
          payeeAgentId: 1n,
          expectedHandleHash: merchantHandleHash,
          expectedLegalHash: merchantLegal,
          expectedPayoutWallet: merchant.address,
          restrictedBuyer: ethers.ZeroAddress,
          amount: 200n * ONE_TUSD8,
          expiresAt: now + 7200n,
          disputeWindow: 0,
          mode: SettlementMode.INSTANT,
          requireAttestation: false,
          strictNoPendingRotation: true,
          metadataHash: hashStr("INV-STRICT-ROT")
        },
        [{ agentId: 1n, expectedWallet: merchant.address, bps: 10000 }]
      );

      const sig = await signSetAgentWallet(registry, rotatedWallet, 1n, rotatedWallet.address, 0n, now + 600n);
      await registry.connect(merchant).setAgentWallet(1n, rotatedWallet.address, now + 600n, sig);

      expect((await escrow.preflightCheck(1n)).reason).to.equal("WALLET_ROTATION_PENDING");
      await expect(
        escrow.connect(buyer).payInvoice(1n, merchantHandleHash, merchantLegal, merchant.address)
      ).to.be.revertedWithCustomError(escrow, "PayeeRotationPending").withArgs(1n);
    });

    it("2.7 blocks payment if required KYB attestation is revoked", async function () {
      const { registry, escrow, attester, merchant, buyer, merchantHandleHash, merchantLegal } = await deployFixture();
      const expiresAt = BigInt(await time.latest()) + 3600n;
      await escrow.connect(merchant).createInvoice(
        {
          payeeAgentId: 1n,
          expectedHandleHash: merchantHandleHash,
          expectedLegalHash: merchantLegal,
          expectedPayoutWallet: merchant.address,
          restrictedBuyer: ethers.ZeroAddress,
          amount: 300n * ONE_TUSD8,
          expiresAt,
          disputeWindow: 0,
          mode: SettlementMode.INSTANT,
          requireAttestation: true,
          strictNoPendingRotation: false,
          metadataHash: hashStr("INV-KYB")
        },
        [{ agentId: 1n, expectedWallet: merchant.address, bps: 10000 }]
      );

      const atts = await registry.getAttestations(1n);
      await registry.connect(attester).revokeAttestation(1n, atts[0].attestationId);

      await expect(
        escrow.connect(buyer).payInvoice(1n, merchantHandleHash, merchantLegal, merchant.address)
      ).to.be.revertedWithCustomError(escrow, "PayeeUnattested").withArgs(1n);
    });
  });

  // ===========================================================================
  // 3. EIP-712 Signed CoP Verification Receipts & Replay Defense
  // ===========================================================================
  describe("3. EIP-712 CoP Receipts, Spoofing & Replay Protection", function () {
    it("3.1 settles payInvoiceWithCoPProof with valid attester signature and blocks replay", async function () {
      const { registry, escrow, attester, merchant, buyer, merchantHandleHash, merchantLegal } = await deployFixture();
      const now = BigInt(await time.latest());
      const params = {
        payeeAgentId: 1n,
        expectedHandleHash: merchantHandleHash,
        expectedLegalHash: merchantLegal,
        expectedPayoutWallet: merchant.address,
        restrictedBuyer: ethers.ZeroAddress,
        amount: 400n * ONE_TUSD8,
        expiresAt: now + 3600n,
        disputeWindow: 0,
        mode: SettlementMode.INSTANT,
        requireAttestation: true,
        strictNoPendingRotation: true,
        metadataHash: hashStr("INV-EIP712-1")
      };
      const splits = [{ agentId: 1n, expectedWallet: merchant.address, bps: 10000 }];

      await escrow.connect(merchant).createInvoice(params, splits); // invoice 1
      await escrow.connect(merchant).createInvoice(params, splits); // invoice 2

      const invoiceSalt = hashStr("SALT-001");
      const deadline = now + 900n;
      const sig = await signCoPReceipt(registry, attester, {
        agentId: 1n,
        handleHash: merchantHandleHash,
        legalEntityHash: merchantLegal,
        payoutWallet: merchant.address,
        invoiceSalt,
        nonce: 77n,
        deadline
      });

      await escrow.connect(buyer).payInvoiceWithCoPProof(
        1n, merchantHandleHash, merchantLegal, merchant.address,
        attester.address, invoiceSalt, 77n, deadline, sig
      );
      expect((await escrow.getInvoice(1n)).status).to.equal(InvoiceStatus.SETTLED);

      // Replaying the exact same CoP receipt against invoice #2 MUST revert
      await expect(
        escrow.connect(buyer).payInvoiceWithCoPProof(
          2n, merchantHandleHash, merchantLegal, merchant.address,
          attester.address, invoiceSalt, 77n, deadline, sig
        )
      ).to.be.revertedWithCustomError(escrow, "CoPReceiptAlreadyUsed");
    });

    it("3.2 accepts payee self-signed CoP receipt and rejects unauthorized signer or expired receipt", async function () {
      const { registry, escrow, merchant, buyer, attacker, merchantHandleHash, merchantLegal } = await deployFixture();
      const now = BigInt(await time.latest());
      await escrow.connect(merchant).createInvoice(
        {
          payeeAgentId: 1n,
          expectedHandleHash: merchantHandleHash,
          expectedLegalHash: merchantLegal,
          expectedPayoutWallet: merchant.address,
          restrictedBuyer: ethers.ZeroAddress,
          amount: 100n * ONE_TUSD8,
          expiresAt: now + 3600n,
          disputeWindow: 0,
          mode: SettlementMode.INSTANT,
          requireAttestation: false,
          strictNoPendingRotation: false,
          metadataHash: hashStr("INV-EIP712-2")
        },
        [{ agentId: 1n, expectedWallet: merchant.address, bps: 10000 }]
      );

      const salt = hashStr("SALT-002");
      // Attacker spoofs receipt
      const badSig = await signCoPReceipt(registry, attacker, {
        agentId: 1n, handleHash: merchantHandleHash, legalEntityHash: merchantLegal,
        payoutWallet: merchant.address, invoiceSalt: salt, nonce: 1n, deadline: now + 600n
      });
      await expect(
        escrow.connect(buyer).payInvoiceWithCoPProof(
          1n, merchantHandleHash, merchantLegal, merchant.address,
          attacker.address, salt, 1n, now + 600n, badSig
        )
      ).to.be.revertedWithCustomError(escrow, "InvalidCoPSignature");

      // Expired receipt
      const expSig = await signCoPReceipt(registry, merchant, {
        agentId: 1n, handleHash: merchantHandleHash, legalEntityHash: merchantLegal,
        payoutWallet: merchant.address, invoiceSalt: salt, nonce: 2n, deadline: now - 10n
      });
      await expect(
        escrow.connect(buyer).payInvoiceWithCoPProof(
          1n, merchantHandleHash, merchantLegal, merchant.address,
          merchant.address, salt, 2n, now - 10n, expSig
        )
      ).to.be.revertedWithCustomError(escrow, "InvalidCoPSignature");

      // Valid self-signed by active payee payoutWallet succeeds
      const okSig = await signCoPReceipt(registry, merchant, {
        agentId: 1n, handleHash: merchantHandleHash, legalEntityHash: merchantLegal,
        payoutWallet: merchant.address, invoiceSalt: salt, nonce: 3n, deadline: now + 600n
      });
      await escrow.connect(buyer).payInvoiceWithCoPProof(
        1n, merchantHandleHash, merchantLegal, merchant.address,
        merchant.address, salt, 3n, now + 600n, okSig
      );
      expect((await escrow.getInvoice(1n)).status).to.equal(InvoiceStatus.SETTLED);
    });

    it("3.3 supports ERC-1271 smart account wallets for setAgentWallet and signed CoP receipts", async function () {
      const { registry, merchant, rotatedWallet, merchantHandleHash, merchantLegal } = await deployFixture();
      const MockWallet = await ethers.getContractFactory("MockERC1271Wallet");
      const smartWallet = await MockWallet.deploy(rotatedWallet.address);
      const smartAddr = await smartWallet.getAddress();

      // Transfer NFT to smartWallet owner so payoutWallet resets to 0x0 and binds immediately
      await registry.connect(merchant).transferFrom(merchant.address, rotatedWallet.address, 1n);
      const now = BigInt(await time.latest());
      const nonce = await registry.walletNonces(1n);
      const bindSig = await signSetAgentWallet(registry, rotatedWallet, 1n, smartAddr, nonce, now + 600n);
      await registry.connect(rotatedWallet).setAgentWallet(1n, smartAddr, now + 600n, bindSig);
      expect(await registry.getAgentWallet(1n)).to.equal(smartAddr);

      // Verify EIP-712 CoP receipt signed by smart account owner validates via ERC-1271
      const salt = hashStr("SMART-1271");
      const copSig = await signCoPReceipt(registry, rotatedWallet, {
        agentId: 1n,
        handleHash: merchantHandleHash,
        legalEntityHash: merchantLegal,
        payoutWallet: smartAddr,
        invoiceSalt: salt,
        nonce: 9n,
        deadline: now + 600n
      });
      const [valid] = await registry.verifySignedCoPReceipt(
        1n, merchantHandleHash, merchantLegal, smartAddr, salt, 9n, now + 600n, smartAddr, copSig
      );
      expect(valid).to.equal(true);
    });
  });

  // ===========================================================================
  // 4. Multi-Party BPS Splits, Rounding Dust & Overflow Safety
  // ===========================================================================
  describe("4. Multi-Party BPS Splits, Dust Safety & Large-Value Invariants", function () {
    it("4.1 enforces BPS sum == 10000, non-zero legs, max 8 legs, and verified split payees", async function () {
      const { escrow, merchant, taxVault, attacker, merchantHandleHash, merchantLegal } = await deployFixture();
      const base = {
        payeeAgentId: 1n,
        expectedHandleHash: merchantHandleHash,
        expectedLegalHash: merchantLegal,
        expectedPayoutWallet: merchant.address,
        restrictedBuyer: ethers.ZeroAddress,
        amount: 100n * ONE_TUSD8,
        expiresAt: BigInt(await time.latest()) + 3600n,
        disputeWindow: 0,
        mode: SettlementMode.INSTANT,
        requireAttestation: false,
        strictNoPendingRotation: false,
        metadataHash: hashStr("INV-SPLIT-ERR")
      };

      // Sum != 10000
      await expect(
        escrow.connect(merchant).createInvoice(base, [
          { agentId: 1n, expectedWallet: merchant.address, bps: 9000 },
          { agentId: 2n, expectedWallet: taxVault.address, bps: 999 }
        ])
      ).to.be.revertedWithCustomError(escrow, "SplitBpsSumMismatch").withArgs(9999n);

      // Empty splits
      await expect(escrow.connect(merchant).createInvoice(base, [])).to.be.revertedWithCustomError(escrow, "InvalidSplits");

      // Zero bps leg
      await expect(
        escrow.connect(merchant).createInvoice(base, [
          { agentId: 1n, expectedWallet: merchant.address, bps: 10000 },
          { agentId: 2n, expectedWallet: taxVault.address, bps: 0 }
        ])
      ).to.be.revertedWithCustomError(escrow, "InvalidSplits");

      // Unverified attacker wallet on split leg 1
      await expect(
        escrow.connect(merchant).createInvoice(base, [
          { agentId: 1n, expectedWallet: merchant.address, bps: 8000 },
          { agentId: 2n, expectedWallet: attacker.address, bps: 2000 }
        ])
      ).to.be.revertedWithCustomError(escrow, "SplitPayeeCheckFailed").withArgs(1n, 2n);
    });

    it("4.2 settles 3-way commercial split (85% Merchant / 10% Tax / 5% Affiliate) with 0 dust", async function () {
      const { tusd8, escrow, merchant, taxVault, affiliate, buyer, merchantHandleHash, merchantLegal } = await deployFixture();
      const amount = 12_500n * ONE_TUSD8;
      await escrow.connect(merchant).createInvoice(
        {
          payeeAgentId: 1n,
          expectedHandleHash: merchantHandleHash,
          expectedLegalHash: merchantLegal,
          expectedPayoutWallet: merchant.address,
          restrictedBuyer: ethers.ZeroAddress,
          amount,
          expiresAt: BigInt(await time.latest()) + 3600n,
          disputeWindow: 0,
          mode: SettlementMode.INSTANT,
          requireAttestation: true,
          strictNoPendingRotation: true,
          metadataHash: hashStr("INV-3WAY")
        },
        [
          { agentId: 1n, expectedWallet: merchant.address, bps: 8500 },
          { agentId: 2n, expectedWallet: taxVault.address, bps: 1000 },
          { agentId: 3n, expectedWallet: affiliate.address, bps: 500 }
        ]
      );

      await escrow.connect(buyer).payInvoice(1n, merchantHandleHash, merchantLegal, merchant.address);

      expect(await tusd8.balanceOf(merchant.address)).to.equal(10_625n * ONE_TUSD8);
      expect(await tusd8.balanceOf(taxVault.address)).to.equal(1_250n * ONE_TUSD8);
      expect(await tusd8.balanceOf(affiliate.address)).to.equal(625n * ONE_TUSD8);
      expect(await tusd8.balanceOf(await escrow.getAddress())).to.equal(0n);
    });

    it("4.3 leaves zero rounding dust on prime & 1-wei base unit splits (3333 / 3333 / 3334)", async function () {
      const { tusd8, escrow, merchant, taxVault, affiliate, buyer, merchantHandleHash, merchantLegal } = await deployFixture();
      const splits = [
        { agentId: 1n, expectedWallet: merchant.address, bps: 3333 },
        { agentId: 2n, expectedWallet: taxVault.address, bps: 3333 },
        { agentId: 3n, expectedWallet: affiliate.address, bps: 3334 }
      ];

      for (const amt of [10_000_003n, 7n, 1n]) {
        const b1 = await tusd8.balanceOf(merchant.address);
        const b2 = await tusd8.balanceOf(taxVault.address);
        const b3 = await tusd8.balanceOf(affiliate.address);

        await escrow.connect(merchant).createInvoice(
          {
            payeeAgentId: 1n,
            expectedHandleHash: merchantHandleHash,
            expectedLegalHash: merchantLegal,
            expectedPayoutWallet: merchant.address,
            restrictedBuyer: ethers.ZeroAddress,
            amount: amt,
            expiresAt: BigInt(await time.latest()) + 3600n,
            disputeWindow: 0,
            mode: SettlementMode.INSTANT,
            requireAttestation: false,
            strictNoPendingRotation: false,
            metadataHash: hashStr("DUST-" + amt.toString())
          },
          splits
        );
        const id = await escrow.invoiceCount();
        await escrow.connect(buyer).payInvoice(id, merchantHandleHash, merchantLegal, merchant.address);

        const d1 = (await tusd8.balanceOf(merchant.address)) - b1;
        const d2 = (await tusd8.balanceOf(taxVault.address)) - b2;
        const d3 = (await tusd8.balanceOf(affiliate.address)) - b3;
        expect(d1 + d2 + d3).to.equal(amt);
        expect(await tusd8.balanceOf(await escrow.getAddress())).to.equal(0n);
      }
    });

    it("4.4 handles $1B-scale 8-way split cleanly without integer overflow or dust", async function () {
      const { tusd8, registry, escrow, merchant, taxVault, affiliate, buyer, extras, merchantHandleHash, merchantLegal } = await deployFixture();
      const splits = [
        { agentId: 1n, expectedWallet: merchant.address, bps: 3000 },
        { agentId: 2n, expectedWallet: taxVault.address, bps: 1000 },
        { agentId: 3n, expectedWallet: affiliate.address, bps: 1000 }
      ];
      for (let i = 0; i < 5; i++) {
        await registry.connect(extras[i]).registerPayee(`subvendor${i}.io`, hashStr(`Sub ${i}`), "ipfs://sub", []);
        const id = await registry.totalAgents();
        splits.push({ agentId: id, expectedWallet: extras[i].address, bps: 1000 });
      }
      expect(splits.length).to.equal(8);

      const bigAmount = 1_000_000_000n * ONE_TUSD8 + 999_999n; // $1,000,000,000.999999 tUSD8
      await tusd8.mint(buyer.address, bigAmount);

      await escrow.connect(merchant).createInvoice(
        {
          payeeAgentId: 1n,
          expectedHandleHash: merchantHandleHash,
          expectedLegalHash: merchantLegal,
          expectedPayoutWallet: merchant.address,
          restrictedBuyer: ethers.ZeroAddress,
          amount: bigAmount,
          expiresAt: BigInt(await time.latest()) + 3600n,
          disputeWindow: 0,
          mode: SettlementMode.INSTANT,
          requireAttestation: false,
          strictNoPendingRotation: false,
          metadataHash: hashStr("INV-1B-8WAY")
        },
        splits
      );

      await escrow.connect(buyer).payInvoice(1n, merchantHandleHash, merchantLegal, merchant.address);

      let totalOut = 0n;
      for (const leg of splits) {
        totalOut += await tusd8.balanceOf(leg.expectedWallet);
      }
      expect(totalOut).to.equal(bigAmount);
      expect(await tusd8.balanceOf(await escrow.getAddress())).to.equal(0n);
    });

    it("4.5 blocks settlement if a secondary split recipient is revoked after issuance", async function () {
      const { registry, escrow, admin, merchant, taxVault, buyer, merchantHandleHash, merchantLegal } = await deployFixture();
      await escrow.connect(merchant).createInvoice(
        {
          payeeAgentId: 1n,
          expectedHandleHash: merchantHandleHash,
          expectedLegalHash: merchantLegal,
          expectedPayoutWallet: merchant.address,
          restrictedBuyer: ethers.ZeroAddress,
          amount: 1000n * ONE_TUSD8,
          expiresAt: BigInt(await time.latest()) + 3600n,
          disputeWindow: 0,
          mode: SettlementMode.INSTANT,
          requireAttestation: false,
          strictNoPendingRotation: false,
          metadataHash: hashStr("INV-REVOKED-SPLIT")
        },
        [
          { agentId: 1n, expectedWallet: merchant.address, bps: 9000 },
          { agentId: 2n, expectedWallet: taxVault.address, bps: 1000 }
        ]
      );

      await registry.connect(admin).revokePayee(2n, hashStr("TAX_VAULT_COMPROMISED"));
      expect((await escrow.preflightCheck(1n)).reason).to.equal("SPLIT_PAYEE_REVOKED");

      await expect(
        escrow.connect(buyer).payInvoice(1n, merchantHandleHash, merchantLegal, merchant.address)
      ).to.be.revertedWithCustomError(escrow, "PayeeRevoked").withArgs(2n);
    });
  });

  // ===========================================================================
  // 5. Milestone Escrow, Disputes, Expiry, Cancellation & Emergency Refund
  // ===========================================================================
  describe("5. Milestone Escrow, Disputes & Emergency Revocation Protection", function () {
    it("5.1 funds milestone escrow and releases early on buyer confirmation", async function () {
      const { tusd8, escrow, merchant, taxVault, buyer, merchantHandleHash, merchantLegal } = await deployFixture();
      const amount = 5000n * ONE_TUSD8;
      await escrow.connect(merchant).createInvoice(
        {
          payeeAgentId: 1n,
          expectedHandleHash: merchantHandleHash,
          expectedLegalHash: merchantLegal,
          expectedPayoutWallet: merchant.address,
          restrictedBuyer: buyer.address,
          amount,
          expiresAt: BigInt(await time.latest()) + 3600n,
          disputeWindow: 86400,
          mode: SettlementMode.MILESTONE_ESCROW,
          requireAttestation: true,
          strictNoPendingRotation: true,
          metadataHash: hashStr("ESCROW-01")
        },
        [
          { agentId: 1n, expectedWallet: merchant.address, bps: 9000 },
          { agentId: 2n, expectedWallet: taxVault.address, bps: 1000 }
        ]
      );

      await escrow.connect(buyer).payInvoice(1n, merchantHandleHash, merchantLegal, merchant.address);
      expect((await escrow.getInvoice(1n)).status).to.equal(InvoiceStatus.FUNDED);
      expect(await tusd8.balanceOf(await escrow.getAddress())).to.equal(amount);

      // Cannot finalize before dispute deadline
      await expect(escrow.connect(merchant).finalizeEscrow(1n)).to.be.revertedWithCustomError(escrow, "DisputeWindowActive");

      // Buyer releases early
      await escrow.connect(buyer).releaseEscrow(1n);
      expect((await escrow.getInvoice(1n)).status).to.equal(InvoiceStatus.SETTLED);
      expect(await tusd8.balanceOf(merchant.address)).to.equal(4500n * ONE_TUSD8);
      expect(await tusd8.balanceOf(taxVault.address)).to.equal(500n * ONE_TUSD8);
      expect(await tusd8.balanceOf(await escrow.getAddress())).to.equal(0n);
    });

    it("5.2 allows finalizeEscrow after dispute window lapses with no dispute", async function () {
      const { tusd8, escrow, merchant, buyer, merchantHandleHash, merchantLegal } = await deployFixture();
      const amount = 1000n * ONE_TUSD8;
      await escrow.connect(merchant).createInvoice(
        {
          payeeAgentId: 1n,
          expectedHandleHash: merchantHandleHash,
          expectedLegalHash: merchantLegal,
          expectedPayoutWallet: merchant.address,
          restrictedBuyer: ethers.ZeroAddress,
          amount,
          expiresAt: BigInt(await time.latest()) + 3600n,
          disputeWindow: 3600,
          mode: SettlementMode.MILESTONE_ESCROW,
          requireAttestation: false,
          strictNoPendingRotation: false,
          metadataHash: hashStr("ESCROW-FINALIZE")
        },
        [{ agentId: 1n, expectedWallet: merchant.address, bps: 10000 }]
      );

      await escrow.connect(buyer).payInvoice(1n, merchantHandleHash, merchantLegal, merchant.address);
      await time.increase(3601n);
      await escrow.connect(merchant).finalizeEscrow(1n);

      expect((await escrow.getInvoice(1n)).status).to.equal(InvoiceStatus.SETTLED);
      expect(await tusd8.balanceOf(merchant.address)).to.equal(amount);
    });

    it("5.3 handles buyer dispute & arbiter partial split resolution (40% refund / 60% splits)", async function () {
      const { tusd8, escrow, arbiter, merchant, taxVault, buyer, attacker, merchantHandleHash, merchantLegal } = await deployFixture();
      const amount = 10_001n; // odd micro-unit amount to also stress-test rounding dust!
      await escrow.connect(merchant).createInvoice(
        {
          payeeAgentId: 1n,
          expectedHandleHash: merchantHandleHash,
          expectedLegalHash: merchantLegal,
          expectedPayoutWallet: merchant.address,
          restrictedBuyer: ethers.ZeroAddress,
          amount,
          expiresAt: BigInt(await time.latest()) + 3600n,
          disputeWindow: 7200,
          mode: SettlementMode.MILESTONE_ESCROW,
          requireAttestation: false,
          strictNoPendingRotation: false,
          metadataHash: hashStr("ESCROW-DISPUTE")
        },
        [
          { agentId: 1n, expectedWallet: merchant.address, bps: 8000 },
          { agentId: 2n, expectedWallet: taxVault.address, bps: 2000 }
        ]
      );

      const buyerBefore = await tusd8.balanceOf(buyer.address);
      await escrow.connect(buyer).payInvoice(1n, merchantHandleHash, merchantLegal, merchant.address);

      await escrow.connect(buyer).openDispute(1n, hashStr("DELIVERY_INCOMPLETE"));
      expect((await escrow.getInvoice(1n)).status).to.equal(InvoiceStatus.DISPUTED);

      // Non-arbiter blocked
      await expect(escrow.connect(attacker).resolveDispute(1n, 5000)).to.be.reverted;
      // Invalid > 10000 bps blocked
      await expect(escrow.connect(arbiter).resolveDispute(1n, 10001)).to.be.revertedWithCustomError(escrow, "InvalidRefundBps");

      // Arbiter awards 40% refund to buyer, 60% to merchant+tax splits
      await escrow.connect(arbiter).resolveDispute(1n, 4000);
      const buyerRefunded = amount - (buyerBefore - (await tusd8.balanceOf(buyer.address)));
      const merchGot = await tusd8.balanceOf(merchant.address);
      const taxGot = await tusd8.balanceOf(taxVault.address);
      expect(buyerRefunded + merchGot + taxGot).to.equal(amount);
      expect(await tusd8.balanceOf(await escrow.getAddress())).to.equal(0n);
      expect((await escrow.getInvoice(1n)).status).to.equal(InvoiceStatus.SETTLED);
    });

    it("5.4 protects buyer via emergencyRefundRevokedPayee if payee is revoked post-funding (even when paused)", async function () {
      const { tusd8, registry, escrow, admin, merchant, buyer, merchantHandleHash, merchantLegal } = await deployFixture();
      const amount = 3000n * ONE_TUSD8;
      await escrow.connect(merchant).createInvoice(
        {
          payeeAgentId: 1n,
          expectedHandleHash: merchantHandleHash,
          expectedLegalHash: merchantLegal,
          expectedPayoutWallet: merchant.address,
          restrictedBuyer: ethers.ZeroAddress,
          amount,
          expiresAt: BigInt(await time.latest()) + 3600n,
          disputeWindow: 86400,
          mode: SettlementMode.MILESTONE_ESCROW,
          requireAttestation: false,
          strictNoPendingRotation: false,
          metadataHash: hashStr("ESCROW-REVOKED")
        },
        [{ agentId: 1n, expectedWallet: merchant.address, bps: 10000 }]
      );

      const buyerStart = await tusd8.balanceOf(buyer.address);
      await escrow.connect(buyer).payInvoice(1n, merchantHandleHash, merchantLegal, merchant.address);

      // Cannot emergency-refund before payee is revoked
      await expect(escrow.connect(buyer).emergencyRefundRevokedPayee(1n)).to.be.revertedWithCustomError(escrow, "PayeeNotRevoked");

      // Guardian revokes compromised merchant and pauses protocol
      await registry.connect(admin).revokePayee(1n, hashStr("POST_FUNDING_BREACH"));
      await escrow.connect(admin).pause();

      // Buyer still recovers 100% of funds immediately
      await expect(escrow.connect(buyer).emergencyRefundRevokedPayee(1n))
        .to.emit(escrow, "EmergencyRefundIssued")
        .withArgs(1n, buyer.address, amount, 1n);

      expect(await tusd8.balanceOf(buyer.address)).to.equal(buyerStart);
      expect(await tusd8.balanceOf(await escrow.getAddress())).to.equal(0n);
      expect((await escrow.getInvoice(1n)).status).to.equal(InvoiceStatus.REFUNDED);
    });

    it("5.5 enforces invoice expiry, issuer cancel, and restrictedBuyer guard", async function () {
      const { tusd8, escrow, merchant, buyer, attacker, merchantHandleHash, merchantLegal } = await deployFixture();
      await tusd8.mint(attacker.address, 10_000n * ONE_TUSD8);
      await tusd8.connect(attacker).approve(await escrow.getAddress(), ethers.MaxUint256);

      const now = BigInt(await time.latest());
      await escrow.connect(merchant).createInvoice(
        {
          payeeAgentId: 1n,
          expectedHandleHash: merchantHandleHash,
          expectedLegalHash: merchantLegal,
          expectedPayoutWallet: merchant.address,
          restrictedBuyer: buyer.address,
          amount: 100n * ONE_TUSD8,
          expiresAt: now + 60n,
          disputeWindow: 0,
          mode: SettlementMode.INSTANT,
          requireAttestation: false,
          strictNoPendingRotation: false,
          metadataHash: hashStr("INV-RESTRICTED")
        },
        [{ agentId: 1n, expectedWallet: merchant.address, bps: 10000 }]
      );

      // Wrong buyer blocked
      await expect(
        escrow.connect(attacker).payInvoice(1n, merchantHandleHash, merchantLegal, merchant.address)
      ).to.be.revertedWithCustomError(escrow, "UnauthorizedBuyer");

      // Advance past expiry -> payment reverts, markExpired succeeds
      await time.increase(61n);
      await expect(
        escrow.connect(buyer).payInvoice(1n, merchantHandleHash, merchantLegal, merchant.address)
      ).to.be.revertedWithCustomError(escrow, "InvoiceExpired").withArgs(1n);
      await escrow.markExpired(1n);
      expect((await escrow.getInvoice(1n)).status).to.equal(InvoiceStatus.EXPIRED);

      // Second invoice cancelled by issuer
      const now2 = BigInt(await time.latest());
      await escrow.connect(merchant).createInvoice(
        {
          payeeAgentId: 1n,
          expectedHandleHash: merchantHandleHash,
          expectedLegalHash: merchantLegal,
          expectedPayoutWallet: merchant.address,
          restrictedBuyer: ethers.ZeroAddress,
          amount: 100n * ONE_TUSD8,
          expiresAt: now2 + 3600n,
          disputeWindow: 0,
          mode: SettlementMode.INSTANT,
          requireAttestation: false,
          strictNoPendingRotation: false,
          metadataHash: hashStr("INV-CANCEL")
        },
        [{ agentId: 1n, expectedWallet: merchant.address, bps: 10000 }]
      );
      await expect(escrow.connect(attacker).cancelInvoice(2n)).to.be.revertedWithCustomError(escrow, "UnauthorizedCaller");
      await escrow.connect(merchant).cancelInvoice(2n);
      expect((await escrow.getInvoice(2n)).status).to.equal(InvoiceStatus.CANCELLED);
    });

    it("5.6 prevents partial dispute payout to a revoked payee and allows 100% refund", async function () {
      const { tusd8, registry, escrow, admin, arbiter, merchant, buyer, merchantHandleHash, merchantLegal } = await deployFixture();
      const amount = 2000n * ONE_TUSD8;
      await escrow.connect(merchant).createInvoice(
        {
          payeeAgentId: 1n,
          expectedHandleHash: merchantHandleHash,
          expectedLegalHash: merchantLegal,
          expectedPayoutWallet: merchant.address,
          restrictedBuyer: ethers.ZeroAddress,
          amount,
          expiresAt: BigInt(await time.latest()) + 3600n,
          disputeWindow: 7200,
          mode: SettlementMode.MILESTONE_ESCROW,
          requireAttestation: false,
          strictNoPendingRotation: false,
          metadataHash: hashStr("DISPUTE-REVOKED")
        },
        [{ agentId: 1n, expectedWallet: merchant.address, bps: 10000 }]
      );

      const buyerBefore = await tusd8.balanceOf(buyer.address);
      await escrow.connect(buyer).payInvoice(1n, merchantHandleHash, merchantLegal, merchant.address);
      await escrow.connect(buyer).openDispute(1n, hashStr("FRAUD_SUSPECTED"));
      await registry.connect(admin).revokePayee(1n, hashStr("CONFIRMED_FRAUD"));

      // Arbiter cannot award 50% to a revoked payee
      await expect(
        escrow.connect(arbiter).resolveDispute(1n, 5000)
      ).to.be.revertedWithCustomError(escrow, "PayeeRevoked").withArgs(1n);

      // 100% buyer refund succeeds cleanly
      await escrow.connect(arbiter).resolveDispute(1n, 10000);
      expect(await tusd8.balanceOf(buyer.address)).to.equal(buyerBefore);
      expect((await escrow.getInvoice(1n)).status).to.equal(InvoiceStatus.REFUNDED);
    });
  });

  // ===========================================================================
  // 6. Adversarial Security: Reentrancy, Access Control & Pausability
  // ===========================================================================
  describe("6. Adversarial Security: Reentrancy, Access Control & Pause", function () {
    it("6.1 blocks reentrancy during payInvoice and releaseEscrow via malicious ERC-20 hook", async function () {
      const [admin, arbiter, merchant, buyer] = await ethers.getSigners();
      const ReentrantTUSD8 = await ethers.getContractFactory("ReentrantTUSD8");
      const evilToken = await ReentrantTUSD8.deploy();

      const Registry = await ethers.getContractFactory("ERC8004PayeeRegistry");
      const registry = await Registry.deploy(admin.address, COOLDOWN);
      const handleHash = hashStr("merchant.sec");
      const legalHash = hashStr("Merchant Sec Ltd");
      await registry.connect(merchant).registerPayee("merchant.sec", legalHash, "ipfs://sec", []);

      const Escrow = await ethers.getContractFactory("PayeeShieldInvoiceEscrow");
      const escrow = await Escrow.deploy(
        await evilToken.getAddress(),
        await registry.getAddress(),
        admin.address,
        arbiter.address
      );

      await evilToken.mint(buyer.address, 5000n * ONE_TUSD8);
      await evilToken.connect(buyer).approve(await escrow.getAddress(), ethers.MaxUint256);

      const now = BigInt(await time.latest());
      await escrow.connect(merchant).createInvoice(
        {
          payeeAgentId: 1n,
          expectedHandleHash: handleHash,
          expectedLegalHash: legalHash,
          expectedPayoutWallet: merchant.address,
          restrictedBuyer: ethers.ZeroAddress,
          amount: 1000n * ONE_TUSD8,
          expiresAt: now + 3600n,
          disputeWindow: 3600,
          mode: SettlementMode.MILESTONE_ESCROW,
          requireAttestation: false,
          strictNoPendingRotation: false,
          metadataHash: hashStr("INV-REENTER")
        },
        [{ agentId: 1n, expectedWallet: merchant.address, bps: 10000 }]
      );

      // Arm reentrancy into payInvoice during transferFrom
      const payData = escrow.interface.encodeFunctionData("payInvoice", [1n, handleHash, legalHash, merchant.address]);
      await evilToken.armAttack(await escrow.getAddress(), payData);
      await escrow.connect(buyer).payInvoice(1n, handleHash, legalHash, merchant.address);
      expect(await evilToken.reentryAttempted()).to.equal(true);
      expect(await evilToken.reentrySucceeded()).to.equal(false);
      expect(await evilToken.balanceOf(await escrow.getAddress())).to.equal(1000n * ONE_TUSD8);

      // Arm reentrancy into releaseEscrow during payout transfer
      const relData = escrow.interface.encodeFunctionData("releaseEscrow", [1n]);
      await evilToken.armAttack(await escrow.getAddress(), relData);
      await escrow.connect(buyer).releaseEscrow(1n);
      expect(await evilToken.reentryAttempted()).to.equal(true);
      expect(await evilToken.reentrySucceeded()).to.equal(false);
      expect(await evilToken.balanceOf(merchant.address)).to.equal(1000n * ONE_TUSD8);
      expect(await evilToken.balanceOf(await escrow.getAddress())).to.equal(0n);
    });

    it("6.2 enforces strict RBAC access control across registry and escrow", async function () {
      const { registry, escrow, attacker, merchant, merchantHandleHash, merchantLegal } = await deployFixture();

      await expect(registry.connect(attacker).setRotationCooldown(0)).to.be.reverted;
      await expect(registry.connect(attacker).pause()).to.be.reverted;
      await expect(registry.connect(attacker).issueAttestation(1n, SCHEMA_KYB, EVIDENCE_HASH, 0)).to.be.reverted;
      await expect(registry.connect(attacker).revokePayee(1n, hashStr("X"))).to.be.revertedWithCustomError(
        registry,
        "NotAgentController"
      );

      await expect(escrow.connect(attacker).pause()).to.be.reverted;
      // Attacker cannot issue invoice impersonating merchant's agentId=1
      await expect(
        escrow.connect(attacker).createInvoice(
          {
            payeeAgentId: 1n,
            expectedHandleHash: merchantHandleHash,
            expectedLegalHash: merchantLegal,
            expectedPayoutWallet: merchant.address,
            restrictedBuyer: ethers.ZeroAddress,
            amount: 100n * ONE_TUSD8,
            expiresAt: BigInt(await time.latest()) + 3600n,
            disputeWindow: 0,
            mode: SettlementMode.INSTANT,
            requireAttestation: false,
            strictNoPendingRotation: false,
            metadataHash: hashStr("IMPERSONATE")
          },
          [{ agentId: 1n, expectedWallet: merchant.address, bps: 10000 }]
        )
      ).to.be.revertedWithCustomError(escrow, "UnauthorizedIssuer");
    });

    it("6.3 pause() halts mutations cleanly and unpause() restores operations", async function () {
      const { registry, escrow, admin, merchant, buyer, merchantHandleHash, merchantLegal } = await deployFixture();

      await registry.connect(admin).pause();
      await expect(registry.connect(buyer)["register(string)"]("ipfs://x")).to.be.reverted;
      await registry.connect(admin).unpause();
      await registry.connect(buyer)["register(string)"]("ipfs://x");

      await escrow.connect(admin).pause();
      await expect(
        escrow.connect(merchant).createInvoice(
          {
            payeeAgentId: 1n,
            expectedHandleHash: merchantHandleHash,
            expectedLegalHash: merchantLegal,
            expectedPayoutWallet: merchant.address,
            restrictedBuyer: ethers.ZeroAddress,
            amount: 100n * ONE_TUSD8,
            expiresAt: BigInt(await time.latest()) + 3600n,
            disputeWindow: 0,
            mode: SettlementMode.INSTANT,
            requireAttestation: false,
            strictNoPendingRotation: false,
            metadataHash: hashStr("PAUSED")
          },
          [{ agentId: 1n, expectedWallet: merchant.address, bps: 10000 }]
        )
      ).to.be.reverted;

      await escrow.connect(admin).unpause();
      await escrow.connect(merchant).createInvoice(
        {
          payeeAgentId: 1n,
          expectedHandleHash: merchantHandleHash,
          expectedLegalHash: merchantLegal,
          expectedPayoutWallet: merchant.address,
          restrictedBuyer: ethers.ZeroAddress,
          amount: 100n * ONE_TUSD8,
          expiresAt: BigInt(await time.latest()) + 3600n,
          disputeWindow: 0,
          mode: SettlementMode.INSTANT,
          requireAttestation: false,
          strictNoPendingRotation: false,
          metadataHash: hashStr("UNPAUSED")
        },
        [{ agentId: 1n, expectedWallet: merchant.address, bps: 10000 }]
      );
      expect(await escrow.invoiceCount()).to.equal(1n);
    });

    it("6.4 blocks reentrancy during emergencyRefundRevokedPayee and enforces MAX_SPLITS = 8", async function () {
      const [admin, arbiter, merchant, buyer] = await ethers.getSigners();
      const ReentrantTUSD8 = await ethers.getContractFactory("ReentrantTUSD8");
      const evilToken = await ReentrantTUSD8.deploy();

      const Registry = await ethers.getContractFactory("ERC8004PayeeRegistry");
      const registry = await Registry.deploy(admin.address, COOLDOWN);
      const handleHash = hashStr("merchant.emg");
      const legalHash = hashStr("Merchant Emg Ltd");
      await registry.connect(merchant).registerPayee("merchant.emg", legalHash, "ipfs://emg", []);

      const Escrow = await ethers.getContractFactory("PayeeShieldInvoiceEscrow");
      const escrow = await Escrow.deploy(await evilToken.getAddress(), await registry.getAddress(), admin.address, arbiter.address);
      await evilToken.mint(buyer.address, 5000n * ONE_TUSD8);
      await evilToken.connect(buyer).approve(await escrow.getAddress(), ethers.MaxUint256);

      // 9 splits exceeds MAX_SPLITS (8)
      const nineSplits = Array.from({ length: 9 }, (_, i) => ({
        agentId: 1n,
        expectedWallet: merchant.address,
        bps: i === 8 ? 2000 : 1000
      }));
      const now = BigInt(await time.latest());
      await expect(
        escrow.connect(merchant).createInvoice(
          {
            payeeAgentId: 1n,
            expectedHandleHash: handleHash,
            expectedLegalHash: legalHash,
            expectedPayoutWallet: merchant.address,
            restrictedBuyer: ethers.ZeroAddress,
            amount: 1000n * ONE_TUSD8,
            expiresAt: now + 3600n,
            disputeWindow: 3600,
            mode: SettlementMode.MILESTONE_ESCROW,
            requireAttestation: false,
            strictNoPendingRotation: false,
            metadataHash: hashStr("TOO-MANY-SPLITS")
          },
          nineSplits
        )
      ).to.be.revertedWithCustomError(escrow, "InvalidSplits");

      // Fund escrow -> revoke payee -> arm reentrancy on emergencyRefundRevokedPayee
      await escrow.connect(merchant).createInvoice(
        {
          payeeAgentId: 1n,
          expectedHandleHash: handleHash,
          expectedLegalHash: legalHash,
          expectedPayoutWallet: merchant.address,
          restrictedBuyer: ethers.ZeroAddress,
          amount: 1000n * ONE_TUSD8,
          expiresAt: now + 3600n,
          disputeWindow: 3600,
          mode: SettlementMode.MILESTONE_ESCROW,
          requireAttestation: false,
          strictNoPendingRotation: false,
          metadataHash: hashStr("EMG-REENTER")
        },
        [{ agentId: 1n, expectedWallet: merchant.address, bps: 10000 }]
      );
      await escrow.connect(buyer).payInvoice(1n, handleHash, legalHash, merchant.address);
      await registry.connect(admin).revokePayee(1n, hashStr("KEY_LEAK"));

      const emgData = escrow.interface.encodeFunctionData("emergencyRefundRevokedPayee", [1n]);
      await evilToken.armAttack(await escrow.getAddress(), emgData);
      await escrow.connect(buyer).emergencyRefundRevokedPayee(1n);
      expect(await evilToken.reentryAttempted()).to.equal(true);
      expect(await evilToken.reentrySucceeded()).to.equal(false);
      expect(await evilToken.balanceOf(buyer.address)).to.equal(5000n * ONE_TUSD8);
      expect(await evilToken.balanceOf(await escrow.getAddress())).to.equal(0n);
    });
  });
});
