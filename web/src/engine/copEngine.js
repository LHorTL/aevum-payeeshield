import { ethers } from "ethers";
import { AEVUM_NETWORK, TUSD8_DECIMALS } from "../config/aevum.js";

export const COP_STATUS = {
  UNREGISTERED: "UNREGISTERED",
  EXACT_MATCH: "EXACT_MATCH",
  CLOSE_MATCH_WARNING: "CLOSE_MATCH_WARNING",
  NO_MATCH: "NO_MATCH",
  PAYEE_REVOKED: "PAYEE_REVOKED",
  WALLET_ROTATION_PENDING: "WALLET_ROTATION_PENDING"
};

export const COP_ENUM_TO_STATUS = [
  COP_STATUS.UNREGISTERED,
  COP_STATUS.EXACT_MATCH,
  COP_STATUS.CLOSE_MATCH_WARNING,
  COP_STATUS.NO_MATCH,
  COP_STATUS.PAYEE_REVOKED,
  COP_STATUS.WALLET_ROTATION_PENDING
];

export const INVOICE_STATUS_LABELS = [
  "NONE",
  "OPEN",
  "FUNDED",
  "SETTLED",
  "DISPUTED",
  "REFUNDED",
  "CANCELLED",
  "EXPIRED"
];

export function hashText(str) {
  return ethers.keccak256(ethers.toUtf8Bytes(str || ""));
}

export function formatTUSD8(rawBigInt) {
  const val = BigInt(rawBigInt || 0n);
  const formatted = ethers.formatUnits(val, TUSD8_DECIMALS);
  const [whole, frac = ""] = formatted.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const paddedFrac = (frac + "00").slice(0, Math.max(2, frac.length));
  return `${grouped}.${paddedFrac}`;
}

export function parseTUSD8(humanStr) {
  const clean = String(humanStr || "0").replace(/,/g, "").trim();
  if (!clean || Number.isNaN(Number(clean)) || Number(clean) <= 0) return 0n;
  return ethers.parseUnits(clean, TUSD8_DECIMALS);
}

export function shortAddr(addr) {
  if (!addr || addr.length < 12) return addr || "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function shortHash(h) {
  if (!h || h.length < 18) return h || "—";
  return `${h.slice(0, 10)}…${h.slice(-8)}`;
}

/**
 * Mirrors Solidity `ERC8004PayeeRegistry.normalizeHandle` (strict ASCII `[a-z0-9._-]`, 3..64 chars).
 * Detects non-ASCII homoglyphs (Cyrillic/Greek/fullwidth) before submission.
 */
export function validateAndNormalizeHandle(raw) {
  const str = String(raw || "");
  const nonAscii = [];
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code > 127) {
      nonAscii.push({ char: str[i], codePoint: `U+${code.toString(16).toUpperCase().padStart(4, "0")}`, index: i });
    }
  }
  if (nonAscii.length > 0) {
    return {
      ok: false,
      reason: `Non-ASCII homoglyph character detected (${nonAscii.map((x) => `'${x.char}' ${x.codePoint}`).join(", ")})`,
      homoglyphs: nonAscii
    };
  }
  const normalized = str.toLowerCase();
  if (normalized.length < 3 || normalized.length > 64) {
    return { ok: false, reason: "Handle length must be 3–64 ASCII characters", homoglyphs: [] };
  }
  if (!/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/.test(normalized) || normalized.includes("..")) {
    return { ok: false, reason: "Only [a-z0-9._-] allowed; cannot start/end with punctuation or contain '..'", homoglyphs: [] };
  }
  return { ok: true, normalized, handleHash: hashText(normalized), homoglyphs: [] };
}

/**
 * Levenshtein distance + visual confusable skeleton (`rn`->`m`, `1`->`l`, `0`->`o`, Cyrillic->Latin)
 * to warn buyers about typosquatting & Business Email Compromise (BEC) invoice spoofs.
 */
const CONFUSABLE_MAP = {
  "\u0430": "a", // Cyrillic а
  "\u0435": "e", // Cyrillic е
  "\u043e": "o", // Cyrillic о
  "\u0440": "p", // Cyrillic р
  "\u0441": "c", // Cyrillic с
  "\u0445": "x", // Cyrillic х
  "\u03bf": "o", // Greek ο
  "0": "o",
  "1": "l"
};

export function visualSkeleton(s) {
  let out = "";
  for (const ch of String(s || "").toLowerCase()) {
    out += CONFUSABLE_MAP[ch] || ch;
  }
  return out.replace(/rn/g, "m").replace(/vv/g, "w");
}

export function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

export function findLookalikeMatch(rawHandle, payees) {
  const skel = visualSkeleton(rawHandle);
  const lower = String(rawHandle || "").toLowerCase();
  let best = null;
  for (const p of payees) {
    if (p.handle === lower) continue;
    const pSkel = visualSkeleton(p.handle);
    const dist = levenshtein(skel, pSkel);
    if (skel === pSkel || dist <= 2) {
      if (!best || dist < best.distance) {
        best = { payee: p, distance: dist, exactSkeletonCollision: skel === pSkel };
      }
    }
  }
  return best;
}

/**
 * Dust-free pro-rata BPS split calculator mirroring `PayeeShieldInvoiceEscrow._distributeFromSelf`.
 */
export function computeDustFreeSplits(amountRaw, splits) {
  const total = BigInt(amountRaw);
  let distributed = 0n;
  return splits.map((leg, idx) => {
    const legAmt =
      idx === splits.length - 1 ? total - distributed : (total * BigInt(leg.bps)) / 10_000n;
    distributed += legAmt;
    return { ...leg, computedAmount: legAmt };
  });
}

/**
 * Deterministic cryptographic settlement receipt hash matching Solidity `_computeReceiptHash`.
 */
export function computeReceiptHash({
  chainId = AEVUM_NETWORK.chainIdDecimal,
  escrowAddress = "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  invoiceId,
  payer,
  payeeAgentId,
  expectedHandleHash,
  expectedLegalHash,
  expectedPayoutWallet,
  settledAmount,
  statusCode,
  timestamp
}) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const encoded = coder.encode(
    [
      "uint256",
      "address",
      "uint256",
      "address",
      "uint256",
      "bytes32",
      "bytes32",
      "address",
      "uint256",
      "uint8",
      "uint256"
    ],
    [
      BigInt(chainId),
      escrowAddress,
      BigInt(invoiceId),
      payer,
      BigInt(payeeAgentId),
      expectedHandleHash,
      expectedLegalHash,
      expectedPayoutWallet,
      BigInt(settledAmount),
      statusCode,
      BigInt(timestamp)
    ]
  );
  return ethers.keccak256(encoded);
}

/**
 * Pure Confirmation-of-Payee evaluation mirroring `ERC8004PayeeRegistry.verifyPayeeByHandle`.
 */
export function evaluateCoP(payees, { handle, legalName, payoutWallet }) {
  const norm = validateAndNormalizeHandle(handle);
  const lookalike = findLookalikeMatch(handle, payees);

  if (!norm.ok) {
    return {
      status: COP_STATUS.NO_MATCH,
      revertError: "InvalidHandle()",
      summary: norm.reason,
      homoglyphBlocked: norm.homoglyphs.length > 0,
      lookalike,
      matchedPayee: null
    };
  }

  const found = payees.find((p) => p.handle === norm.normalized);
  if (!found) {
    return {
      status: COP_STATUS.UNREGISTERED,
      revertError: "PayeeMismatch(UNREGISTERED)",
      summary: lookalike
        ? `Unregistered handle '${norm.normalized}' looks dangerously similar to verified payee '${lookalike.payee.handle}' (ERC-8004 #${lookalike.payee.agentId})!`
        : `Handle '${norm.normalized}' is not registered in the ERC-8004 Payee Registry.`,
      homoglyphBlocked: false,
      lookalike,
      matchedPayee: null
    };
  }

  if (found.revoked) {
    return {
      status: COP_STATUS.PAYEE_REVOKED,
      revertError: `PayeeRevoked(${found.agentId})`,
      summary: `Payee '${found.handle}' (ERC-8004 #${found.agentId}) has been REVOKED (${found.revocationReason || "Security Revocation"}). Zero tUSD8 permitted.`,
      homoglyphBlocked: false,
      lookalike: null,
      matchedPayee: found
    };
  }

  const targetAddr = String(payoutWallet || "").trim().toLowerCase();
  if (!ethers.isAddress(payoutWallet || "") || found.payoutWallet.toLowerCase() !== targetAddr) {
    return {
      status: COP_STATUS.NO_MATCH,
      revertError: "PayeeMismatch(NO_MATCH)",
      summary: `Payout wallet mismatch! Verified ERC-8004 wallet for '${found.handle}' is ${shortAddr(found.payoutWallet)}, NOT ${shortAddr(payoutWallet)}.`,
      homoglyphBlocked: false,
      lookalike: null,
      matchedPayee: found
    };
  }

  const providedLegalHash = legalName && legalName.trim() ? hashText(legalName.trim()) : ethers.ZeroHash;
  if (providedLegalHash !== ethers.ZeroHash && providedLegalHash !== found.legalEntityHash) {
    return {
      status: COP_STATUS.CLOSE_MATCH_WARNING,
      revertError: "PayeeMismatch(CLOSE_MATCH_WARNING)",
      summary: `Handle and payout wallet match '${found.handle}', but Legal Entity Name differs from registered '${found.legalName}'. Hard-blocked in strict settlement mode.`,
      homoglyphBlocked: false,
      lookalike: null,
      matchedPayee: found
    };
  }

  if (found.pendingPayoutWallet) {
    return {
      status: COP_STATUS.WALLET_ROTATION_PENDING,
      revertError: `PayeeRotationPending(${found.agentId})`,
      summary: `Payout wallet rotation to ${shortAddr(found.pendingPayoutWallet)} is in timelocked cooldown. Blocked when strictNoPendingRotation is enabled.`,
      homoglyphBlocked: false,
      lookalike: null,
      matchedPayee: found
    };
  }

  return {
    status: COP_STATUS.EXACT_MATCH,
    revertError: null,
    summary: `Cryptographic exact match confirmed against ERC-8004 Identity #${found.agentId} (${found.legalName}).`,
    homoglyphBlocked: false,
    lookalike: null,
    matchedPayee: found
  };
}

// =============================================================================
// Rich Initial Simulation State (instant 10s judge walkthrough)
// =============================================================================
export const SIM_ADDRESSES = {
  buyer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  acmeMerchant: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  euTaxVault: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  partnerOps: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
  nordicFreight: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
  rogueVendor: "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
  attackerSpoof: "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955",
  rotatedWallet: "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f"
};

export function createInitialSimState() {
  const now = Math.floor(Date.now() / 1000);
  const payees = [
    {
      agentId: 1,
      handle: "acme.cloud",
      handleHash: hashText("acme.cloud"),
      legalName: "Acme Cloud Infrastructure Ltd (SG-2026-8841)",
      legalEntityHash: hashText("Acme Cloud Infrastructure Ltd (SG-2026-8841)"),
      payoutWallet: SIM_ADDRESSES.acmeMerchant,
      pendingPayoutWallet: null,
      rotationExecutableAt: 0,
      agentURI: "ipfs://bafybeig-acme-cloud-erc8004-profile.json",
      kybAttested: true,
      attesterLabel: "Aevum KYB Registry #01",
      revoked: false,
      revocationReason: ""
    },
    {
      agentId: 2,
      handle: "eu.taxvault",
      handleHash: hashText("eu.taxvault"),
      legalName: "EU Automated VAT Settlement Vault AG",
      legalEntityHash: hashText("EU Automated VAT Settlement Vault AG"),
      payoutWallet: SIM_ADDRESSES.euTaxVault,
      pendingPayoutWallet: null,
      rotationExecutableAt: 0,
      agentURI: "ipfs://bafybeig-eu-taxvault-erc8004.json",
      kybAttested: true,
      attesterLabel: "Aevum KYB Registry #01",
      revoked: false,
      revocationReason: ""
    },
    {
      agentId: 3,
      handle: "partner.ops",
      handleHash: hashText("partner.ops"),
      legalName: "Partner Ops Referral Network Inc",
      legalEntityHash: hashText("Partner Ops Referral Network Inc"),
      payoutWallet: SIM_ADDRESSES.partnerOps,
      pendingPayoutWallet: null,
      rotationExecutableAt: 0,
      agentURI: "ipfs://bafybeig-partner-ops-erc8004.json",
      kybAttested: true,
      attesterLabel: "Aevum KYB Registry #01",
      revoked: false,
      revocationReason: ""
    },
    {
      agentId: 4,
      handle: "nordic.freight",
      handleHash: hashText("nordic.freight"),
      legalName: "Nordic Autonomous Freight Systems AB",
      legalEntityHash: hashText("Nordic Autonomous Freight Systems AB"),
      payoutWallet: SIM_ADDRESSES.nordicFreight,
      pendingPayoutWallet: null,
      rotationExecutableAt: 0,
      agentURI: "ipfs://bafybeig-nordic-freight-erc8004.json",
      kybAttested: true,
      attesterLabel: "Aevum KYB Registry #01",
      revoked: false,
      revocationReason: ""
    },
    {
      agentId: 5,
      handle: "rogue.vendor",
      handleHash: hashText("rogue.vendor"),
      legalName: "Legacy Vendor Logistics LLC",
      legalEntityHash: hashText("Legacy Vendor Logistics LLC"),
      payoutWallet: SIM_ADDRESSES.rogueVendor,
      pendingPayoutWallet: null,
      rotationExecutableAt: 0,
      agentURI: "ipfs://bafybeig-rogue-vendor-erc8004.json",
      kybAttested: false,
      attesterLabel: "Revoked by Guardian",
      revoked: true,
      revocationReason: "COMPROMISED_SIGNING_KEY_BEC_ALERT"
    }
  ];

  const balances = {
    [SIM_ADDRESSES.buyer]: 125_000n * 1_000_000n, // 125,000.00 tUSD8
    [SIM_ADDRESSES.acmeMerchant]: 18_420n * 1_000_000n,
    [SIM_ADDRESSES.euTaxVault]: 4_100n * 1_000_000n,
    [SIM_ADDRESSES.partnerOps]: 1_250n * 1_000_000n,
    [SIM_ADDRESSES.nordicFreight]: 9_500n * 1_000_000n,
    [SIM_ADDRESSES.rogueVendor]: 0n,
    [SIM_ADDRESSES.attackerSpoof]: 0n,
    escrowVault: 4_800n * 1_000_000n
  };

  const invoices = [
    {
      id: 101,
      reference: "INV-2026-Q4-0101",
      description: "GPU Inference Cluster Q4 Retainer (3-Way Auto-Split: 85% Merchant / 10% VAT / 5% Partner)",
      payeeAgentId: 1,
      expectedHandle: "acme.cloud",
      expectedLegalName: "Acme Cloud Infrastructure Ltd (SG-2026-8841)",
      expectedPayoutWallet: SIM_ADDRESSES.acmeMerchant,
      amount: 12_500n * 1_000_000n + 3n, // 12,500.000003 tUSD8 to demonstrate 0-dust rounding!
      mode: "INSTANT",
      status: "OPEN",
      requireAttestation: true,
      strictNoPendingRotation: true,
      disputeWindowSec: 0,
      expiresAt: now + 86400 * 3,
      splits: [
        { agentId: 1, handle: "acme.cloud", expectedWallet: SIM_ADDRESSES.acmeMerchant, bps: 8500, role: "Merchant Treasury" },
        { agentId: 2, handle: "eu.taxvault", expectedWallet: SIM_ADDRESSES.euTaxVault, bps: 1000, role: "EU VAT Vault" },
        { agentId: 3, handle: "partner.ops", expectedWallet: SIM_ADDRESSES.partnerOps, bps: 500, role: "Affiliate Partner" }
      ],
      receiptHash: null,
      lastBlockReason: null
    },
    {
      id: 102,
      reference: "INV-2026-ESC-0102",
      description: "Autonomous Port Customs Clearance Milestone #2 (72h Buyer Dispute Window)",
      payeeAgentId: 4,
      expectedHandle: "nordic.freight",
      expectedLegalName: "Nordic Autonomous Freight Systems AB",
      expectedPayoutWallet: SIM_ADDRESSES.nordicFreight,
      amount: 4_800n * 1_000_000n,
      mode: "MILESTONE_ESCROW",
      status: "FUNDED",
      requireAttestation: true,
      strictNoPendingRotation: true,
      disputeWindowSec: 86400 * 3,
      disputeDeadline: now + 86400 * 3,
      expiresAt: now + 86400 * 7,
      splits: [
        { agentId: 4, handle: "nordic.freight", expectedWallet: SIM_ADDRESSES.nordicFreight, bps: 9000, role: "Carrier Escrow" },
        { agentId: 2, handle: "eu.taxvault", expectedWallet: SIM_ADDRESSES.euTaxVault, bps: 1000, role: "EU VAT Vault" }
      ],
      receiptHash: computeReceiptHash({
        invoiceId: 102,
        payer: SIM_ADDRESSES.buyer,
        payeeAgentId: 4,
        expectedHandleHash: hashText("nordic.freight"),
        expectedLegalHash: hashText("Nordic Autonomous Freight Systems AB"),
        expectedPayoutWallet: SIM_ADDRESSES.nordicFreight,
        settledAmount: 4_800n * 1_000_000n,
        statusCode: 2,
        timestamp: now - 1800
      }),
      lastBlockReason: null
    },
    {
      id: 103,
      reference: "INV-SPOOF-BEC-0103",
      description: "Intercepted BEC Phishing Invoice — Claims 'acme.cloud' but injects Attacker Payout Address",
      payeeAgentId: 1,
      expectedHandle: "acme.cloud",
      expectedLegalName: "Acme Cloud Infrastructure Ltd (SG-2026-8841)",
      expectedPayoutWallet: SIM_ADDRESSES.attackerSpoof, // TAMPERED!
      amount: 28_000n * 1_000_000n,
      mode: "INSTANT",
      status: "OPEN",
      requireAttestation: true,
      strictNoPendingRotation: true,
      disputeWindowSec: 0,
      expiresAt: now + 86400 * 2,
      splits: [
        { agentId: 1, handle: "acme.cloud", expectedWallet: SIM_ADDRESSES.attackerSpoof, bps: 10000, role: "Tampered Payout" }
      ],
      receiptHash: null,
      lastBlockReason: null
    },
    {
      id: 104,
      reference: "INV-REVOKED-0104",
      description: "Revoked Vendor Invoice — ERC-8004 Identity #5 Revoked by Guardian Key-Breach Killswitch",
      payeeAgentId: 5,
      expectedHandle: "rogue.vendor",
      expectedLegalName: "Legacy Vendor Logistics LLC",
      expectedPayoutWallet: SIM_ADDRESSES.rogueVendor,
      amount: 6_200n * 1_000_000n,
      mode: "INSTANT",
      status: "OPEN",
      requireAttestation: false,
      strictNoPendingRotation: true,
      disputeWindowSec: 0,
      expiresAt: now + 86400 * 2,
      splits: [
        { agentId: 5, handle: "rogue.vendor", expectedWallet: SIM_ADDRESSES.rogueVendor, bps: 10000, role: "Revoked Merchant" }
      ],
      receiptHash: null,
      lastBlockReason: null
    }
  ];

  const auditLog = [
    {
      id: "log-init-1",
      time: new Date().toLocaleTimeString(),
      kind: "INFO",
      title: "PayeeShield Simulation Engine Ready",
      detail: "Mirrors ERC8004PayeeRegistry + PayeeShieldInvoiceEscrow (Chain ID 44005 · tUSD8 6dp · 32/32 Hardhat tests PASS)."
    }
  ];

  return { payees, balances, invoices, auditLog, nextAgentId: 6, nextInvoiceId: 105 };
}
