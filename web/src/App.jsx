import React, { useMemo, useState } from "react";
import { ethers } from "ethers";
import {
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  FileText,
  Users,
  Wallet,
  Sparkles,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Split,
  Lock,
  RefreshCw,
  ExternalLink,
  Download,
  Clock,
  Scale,
  Ban,
  Plus
} from "lucide-react";
import { AEVUM_NETWORK, REGISTRY_ABI, ESCROW_ABI, ERC20_ABI } from "./config/aevum.js";
import {
  COP_STATUS,
  COP_ENUM_TO_STATUS,
  SIM_ADDRESSES,
  createInitialSimState,
  evaluateCoP,
  computeDustFreeSplits,
  computeReceiptHash,
  validateAndNormalizeHandle,
  formatTUSD8,
  parseTUSD8,
  hashText,
  shortAddr,
  shortHash
} from "./engine/copEngine.js";
import { useAevumWallet } from "./hooks/useAevumWallet.js";

const TABS = [
  { id: "cop", label: "CoP Inspector", icon: ShieldCheck },
  { id: "invoices", label: "Invoice Queue & Pay", icon: FileText },
  { id: "issue", label: "Issue Split Invoice", icon: Split },
  { id: "registry", label: "ERC-8004 Registry", icon: Users }
];

export default function App() {
  const [mode, setMode] = useState("sim"); // "sim" | "live"
  const [activeTab, setActiveTab] = useState("cop");
  const [sim, setSim] = useState(() => createInitialSimState());
  const wallet = useAevumWallet();

  // Live contract addresses (editable after deploying with `npm run deploy:aevum`)
  const [liveRegistryAddr, setLiveRegistryAddr] = useState(AEVUM_NETWORK.contracts.registry);
  const [liveEscrowAddr, setLiveEscrowAddr] = useState(AEVUM_NETWORK.contracts.escrow);
  const [liveStatusMsg, setLiveStatusMsg] = useState("");
  const [liveInvoiceIdInput, setLiveInvoiceIdInput] = useState("1");

  // CoP Inspector form state
  const [copHandle, setCopHandle] = useState("acme.cloud");
  const [copLegal, setCopLegal] = useState("Acme Cloud Infrastructure Ltd (SG-2026-8841)");
  const [copWallet, setCopWallet] = useState(SIM_ADDRESSES.acmeMerchant);
  const [liveCopResult, setLiveCopResult] = useState(null);

  // Issue Invoice form state
  const [invMerchantId, setInvMerchantId] = useState(1);
  const [invRef, setInvRef] = useState("INV-2026-Q4-0105");
  const [invDesc, setInvDesc] = useState("Autonomous AI Compute Settlement — Verified Multi-Split");
  const [invAmountStr, setInvAmountStr] = useState("5000.000001");
  const [invMode, setInvMode] = useState("INSTANT");
  const [invDisputeHours, setInvDisputeHours] = useState(48);
  const [invRequireKyb, setInvRequireKyb] = useState(true);
  const [invStrictRotation, setInvStrictRotation] = useState(true);
  const [invSplits, setInvSplits] = useState([
    { agentId: 1, bps: 8500, role: "Merchant Treasury" },
    { agentId: 2, bps: 1000, role: "EU VAT Vault" },
    { agentId: 3, bps: 500, role: "Partner Affiliate" }
  ]);
  const [issueError, setIssueError] = useState("");

  // Registry registration form
  const [newHandle, setNewHandle] = useState("");
  const [newLegal, setNewLegal] = useState("");
  const [newWalletAddr, setNewWalletAddr] = useState("0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199");
  const [regMessage, setRegMessage] = useState(null);

  // Dispute arbiter slider per invoice id
  const [refundSliders, setRefundSliders] = useState({});

  const appendLog = (kind, title, detail) => {
    setSim((prev) => ({
      ...prev,
      auditLog: [
        {
          id: `log-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
          time: new Date().toLocaleTimeString(),
          kind,
          title,
          detail
        },
        ...prev.auditLog
      ].slice(0, 40)
    }));
  };

  // Evaluate CoP live in Simulation Mode
  const simCopEval = useMemo(
    () => evaluateCoP(sim.payees, { handle: copHandle, legalName: copLegal, payoutWallet: copWallet }),
    [sim.payees, copHandle, copLegal, copWallet]
  );

  // KPIs
  const kpis = useMemo(() => {
    const activePayees = sim.payees.filter((p) => !p.revoked).length;
    const settledCount = sim.invoices.filter((i) => i.status === "SETTLED").length;
    const blockedAttempts = sim.auditLog.filter((l) => l.kind === "BLOCKED").length;
    return {
      buyerBal: sim.balances[SIM_ADDRESSES.buyer] || 0n,
      escrowBal: sim.balances.escrowVault || 0n,
      activePayees,
      totalPayees: sim.payees.length,
      settledCount,
      blockedAttempts
    };
  }, [sim]);

  // Preset helper for CoP Inspector
  const applyPreset = (preset) => {
    setLiveCopResult(null);
    if (preset === "exact") {
      setCopHandle("acme.cloud");
      setCopLegal("Acme Cloud Infrastructure Ltd (SG-2026-8841)");
      setCopWallet(SIM_ADDRESSES.acmeMerchant);
    } else if (preset === "close") {
      setCopHandle("acme.cloud");
      setCopLegal("Acme Cloud Holdings Offshore LLC");
      setCopWallet(SIM_ADDRESSES.acmeMerchant);
    } else if (preset === "spoof") {
      setCopHandle("acrne.cloud"); // lookalike rn -> m
      setCopLegal("Acme Cloud Infrastructure Ltd (SG-2026-8841)");
      setCopWallet(SIM_ADDRESSES.attackerSpoof);
    } else if (preset === "homoglyph") {
      setCopHandle("\u0430cme.cloud"); // Cyrillic 'а' U+0430
      setCopLegal("Acme Cloud Infrastructure Ltd (SG-2026-8841)");
      setCopWallet(SIM_ADDRESSES.attackerSpoof);
    } else if (preset === "revoked") {
      setCopHandle("rogue.vendor");
      setCopLegal("Legacy Vendor Logistics LLC");
      setCopWallet(SIM_ADDRESSES.rogueVendor);
    }
  };

  // Run live on-chain verifyPayeeByHandle when in Aevum Live mode
  const runLiveCoPCheck = async () => {
    setLiveStatusMsg("");
    setLiveCopResult(null);
    if (!ethers.isAddress(liveRegistryAddr)) {
      setLiveStatusMsg("Enter a deployed ERC8004PayeeRegistry address on Chain ID 44005 first (see scripts/deploy.mjs).");
      return;
    }
    try {
      const provider = window.ethereum
        ? new ethers.BrowserProvider(window.ethereum)
        : new ethers.JsonRpcProvider(AEVUM_NETWORK.rpcUrl);
      const reg = new ethers.Contract(liveRegistryAddr, REGISTRY_ABI, provider);
      const legalHash = copLegal.trim() ? hashText(copLegal.trim()) : ethers.ZeroHash;
      const res = await reg.verifyPayeeByHandle(copHandle, legalHash, copWallet);
      const status = COP_ENUM_TO_STATUS[Number(res.status)] || COP_STATUS.NO_MATCH;
      setLiveCopResult({
        status,
        agentId: res.resolvedAgentId.toString(),
        activeWallet: res.activePayoutWallet,
        hasPendingRotation: res.hasPendingRotation,
        isAttested: res.isAttested
      });
    } catch (e) {
      setLiveStatusMsg(`On-chain revert/error: ${e?.shortMessage || e?.message}`);
    }
  };

  // Live Aevum Testnet: approve tUSD8 & payInvoice with mandatory CoP check
  const runLivePayInvoice = async () => {
    setLiveStatusMsg("");
    if (!window.ethereum || !wallet.account) {
      setLiveStatusMsg("Connect MetaMask / EIP-1193 wallet on QDay Aevum Testnet (Chain ID 44005) first.");
      return;
    }
    if (!ethers.isAddress(liveEscrowAddr)) {
      setLiveStatusMsg("Enter a deployed PayeeShieldInvoiceEscrow contract address on Chain ID 44005.");
      return;
    }
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const escrow = new ethers.Contract(liveEscrowAddr, ESCROW_ABI, signer);
      const invoiceId = BigInt(liveInvoiceIdInput || "1");
      const [payableNow, , reason] = await escrow.preflightCheck(invoiceId);
      if (!payableNow) {
        setLiveStatusMsg(`Pre-flight CoP blocked on-chain: ${reason} (0 tUSD8 moved).`);
        return;
      }
      const inv = await escrow.getInvoice(invoiceId);
      const token = new ethers.Contract(AEVUM_NETWORK.contracts.tUSD8, ERC20_ABI, signer);
      const currentAllowance = await token.allowance(wallet.account, liveEscrowAddr);
      if (currentAllowance < inv.amount) {
        setLiveStatusMsg("Requesting tUSD8 ERC-20 approval...");
        const appTx = await token.approve(liveEscrowAddr, inv.amount);
        await appTx.wait();
      }
      setLiveStatusMsg("Submitting CoP-gated payInvoice transaction to Aevum Testnet (44005)...");
      const payTx = await escrow.payInvoice(
        invoiceId,
        inv.expectedHandleHash,
        inv.expectedLegalHash,
        inv.expectedPayoutWallet
      );
      const rcpt = await payTx.wait();
      setLiveStatusMsg(`Settled on Aevum 44005! Tx: ${rcpt.hash}`);
      wallet.refreshBalances(wallet.account);
    } catch (e) {
      setLiveStatusMsg(`Live transaction reverted: ${e?.shortMessage || e?.message}`);
    }
  };

  // Simulation: Execute CoP-gated invoice payment
  const handlePayInvoiceSim = (invoiceId) => {
    const inv = sim.invoices.find((i) => i.id === invoiceId);
    if (!inv || inv.status !== "OPEN") return;

    const primaryEval = evaluateCoP(sim.payees, {
      handle: inv.expectedHandle,
      legalName: inv.expectedLegalName,
      payoutWallet: inv.expectedPayoutWallet
    });

    const primaryPayee = sim.payees.find((p) => p.agentId === inv.payeeAgentId);
    let blockErr = null;

    if (primaryEval.status === COP_STATUS.PAYEE_REVOKED) {
      blockErr = `REVERT PayeeRevoked(${inv.payeeAgentId}) — 0.000000 tUSD8 moved`;
    } else if (primaryEval.status === COP_STATUS.WALLET_ROTATION_PENDING && inv.strictNoPendingRotation) {
      blockErr = `REVERT PayeeRotationPending(${inv.payeeAgentId}) — wallet rotation cooldown active; 0.000000 tUSD8 moved`;
    } else if (
      primaryEval.status !== COP_STATUS.EXACT_MATCH &&
      primaryEval.status !== COP_STATUS.WALLET_ROTATION_PENDING
    ) {
      blockErr = `REVERT ${primaryEval.revertError || "PayeeMismatch"} — ${primaryEval.summary} (0.000000 tUSD8 moved)`;
    } else if (inv.requireAttestation && (!primaryPayee || !primaryPayee.kybAttested)) {
      blockErr = `REVERT PayeeUnattested(${inv.payeeAgentId}) — KYB attestation required; 0.000000 tUSD8 moved`;
    }

    // Check every split leg against live ERC-8004 registry
    if (!blockErr) {
      for (let i = 0; i < inv.splits.length; i++) {
        const leg = inv.splits[i];
        const lp = sim.payees.find((p) => p.agentId === leg.agentId);
        if (!lp || lp.revoked) {
          blockErr = `REVERT PayeeRevoked(${leg.agentId}) on split leg #${i + 1} — 0.000000 tUSD8 moved`;
          break;
        }
        if (lp.payoutWallet.toLowerCase() !== leg.expectedWallet.toLowerCase()) {
          blockErr = `REVERT SplitPayeeCheckFailed(${i}, ${leg.agentId}) — split wallet mismatch; 0.000000 tUSD8 moved`;
          break;
        }
      }
    }

    if (!blockErr && (sim.balances[SIM_ADDRESSES.buyer] || 0n) < inv.amount) {
      blockErr = "Insufficient simulated buyer tUSD8 balance.";
    }

    if (blockErr) {
      setSim((prev) => ({
        ...prev,
        invoices: prev.invoices.map((x) => (x.id === invoiceId ? { ...x, lastBlockReason: blockErr } : x)),
        auditLog: [
          {
            id: `log-${Date.now()}`,
            time: new Date().toLocaleTimeString(),
            kind: "BLOCKED",
            title: `CoP Shield Blocked Invoice #${invoiceId} (${inv.reference})`,
            detail: blockErr
          },
          ...prev.auditLog
        ]
      }));
      return;
    }

    const ts = Math.floor(Date.now() / 1000);
    const isInstant = inv.mode === "INSTANT";
    const nextStatus = isInstant ? "SETTLED" : "FUNDED";
    const statusCode = isInstant ? 3 : 2;
    const receiptHash = computeReceiptHash({
      invoiceId: inv.id,
      payer: SIM_ADDRESSES.buyer,
      payeeAgentId: inv.payeeAgentId,
      expectedHandleHash: hashText(inv.expectedHandle),
      expectedLegalHash: hashText(inv.expectedLegalName),
      expectedPayoutWallet: inv.expectedPayoutWallet,
      settledAmount: inv.amount,
      statusCode,
      timestamp: ts
    });

    const computedSplits = computeDustFreeSplits(inv.amount, inv.splits);

    setSim((prev) => {
      const nextBalances = { ...prev.balances };
      nextBalances[SIM_ADDRESSES.buyer] = (nextBalances[SIM_ADDRESSES.buyer] || 0n) - inv.amount;

      if (isInstant) {
        for (const leg of computedSplits) {
          nextBalances[leg.expectedWallet] = (nextBalances[leg.expectedWallet] || 0n) + leg.computedAmount;
        }
      } else {
        nextBalances.escrowVault = (nextBalances.escrowVault || 0n) + inv.amount;
      }

      const splitSummary = computedSplits
        .map((l) => `${l.handle} +${formatTUSD8(l.computedAmount)}`)
        .join(" | ");

      return {
        ...prev,
        balances: nextBalances,
        invoices: prev.invoices.map((x) =>
          x.id === invoiceId
            ? {
                ...x,
                status: nextStatus,
                receiptHash,
                disputeDeadline: isInstant ? 0 : ts + (x.disputeWindowSec || 86400),
                lastBlockReason: null
              }
            : x
        ),
        auditLog: [
          {
            id: `log-${Date.now()}`,
            time: new Date().toLocaleTimeString(),
            kind: "SUCCESS",
            title: isInstant
              ? `CoP Exact Match -> Settled #${invoiceId} (${formatTUSD8(inv.amount)} tUSD8)`
              : `CoP Exact Match -> Funded Escrow #${invoiceId} (${formatTUSD8(inv.amount)} tUSD8)`,
            detail: isInstant
              ? `${splitSummary} · Receipt ${shortHash(receiptHash)} (0 wei dust)`
              : `Locked in PayeeShieldInvoiceEscrow · Receipt ${shortHash(receiptHash)}`
          },
          ...prev.auditLog
        ]
      };
    });
  };

  // Escrow Release (re-verifies CoP before payout!)
  const handleReleaseEscrowSim = (invoiceId) => {
    const inv = sim.invoices.find((i) => i.id === invoiceId);
    if (!inv || inv.status !== "FUNDED") return;
    const primary = sim.payees.find((p) => p.agentId === inv.payeeAgentId);
    if (!primary || primary.revoked) {
      const err = `REVERT PayeeRevoked(${inv.payeeAgentId}) at release time — buyer can invoke Emergency 100% Refund!`;
      setSim((prev) => ({
        ...prev,
        invoices: prev.invoices.map((x) => (x.id === invoiceId ? { ...x, lastBlockReason: err } : x))
      }));
      appendLog("BLOCKED", `Release Blocked for Escrow #${invoiceId}`, err);
      return;
    }

    const ts = Math.floor(Date.now() / 1000);
    const receiptHash = computeReceiptHash({
      invoiceId: inv.id,
      payer: SIM_ADDRESSES.buyer,
      payeeAgentId: inv.payeeAgentId,
      expectedHandleHash: hashText(inv.expectedHandle),
      expectedLegalHash: hashText(inv.expectedLegalName),
      expectedPayoutWallet: inv.expectedPayoutWallet,
      settledAmount: inv.amount,
      statusCode: 3,
      timestamp: ts
    });
    const computedSplits = computeDustFreeSplits(inv.amount, inv.splits);

    setSim((prev) => {
      const nextBalances = { ...prev.balances };
      nextBalances.escrowVault = (nextBalances.escrowVault || 0n) - inv.amount;
      for (const leg of computedSplits) {
        nextBalances[leg.expectedWallet] = (nextBalances[leg.expectedWallet] || 0n) + leg.computedAmount;
      }
      return {
        ...prev,
        balances: nextBalances,
        invoices: prev.invoices.map((x) =>
          x.id === invoiceId ? { ...x, status: "SETTLED", receiptHash, lastBlockReason: null } : x
        ),
        auditLog: [
          {
            id: `log-${Date.now()}`,
            time: new Date().toLocaleTimeString(),
            kind: "SUCCESS",
            title: `Escrow #${invoiceId} Released after Re-Verified CoP`,
            detail: `Distributed ${formatTUSD8(inv.amount)} tUSD8 across ${inv.splits.length} verified legs · Receipt ${shortHash(receiptHash)}`
          },
          ...prev.auditLog
        ]
      };
    });
  };

  // Open Dispute
  const handleOpenDisputeSim = (invoiceId) => {
    setSim((prev) => ({
      ...prev,
      invoices: prev.invoices.map((x) =>
        x.id === invoiceId && x.status === "FUNDED" ? { ...x, status: "DISPUTED", lastBlockReason: null } : x
      )
    }));
    appendLog("WARN", `Buyer Opened Dispute on Escrow #${invoiceId}`, "Escrow release frozen pending ARBITER_ROLE resolution.");
  };

  // Arbiter Resolve Dispute
  const handleResolveDisputeSim = (invoiceId, refundBps) => {
    const inv = sim.invoices.find((i) => i.id === invoiceId);
    if (!inv || inv.status !== "DISPUTED") return;
    const primary = sim.payees.find((p) => p.agentId === inv.payeeAgentId);

    const buyerRefund = (inv.amount * BigInt(refundBps)) / 10_000n;
    const payeePortion = inv.amount - buyerRefund;

    if (payeePortion > 0n && (!primary || primary.revoked)) {
      appendLog("BLOCKED", `Arbiter Payout Blocked (#${invoiceId})`, `REVERT PayeeRevoked(${inv.payeeAgentId}): revoked payee cannot receive dispute share. Set refund to 100%.`);
      return;
    }

    const computedSplits = payeePortion > 0n ? computeDustFreeSplits(payeePortion, inv.splits) : [];
    const nextStatus = payeePortion === 0n ? "REFUNDED" : "SETTLED";
    const receiptHash = computeReceiptHash({
      invoiceId: inv.id,
      payer: SIM_ADDRESSES.buyer,
      payeeAgentId: inv.payeeAgentId,
      expectedHandleHash: hashText(inv.expectedHandle),
      expectedLegalHash: hashText(inv.expectedLegalName),
      expectedPayoutWallet: inv.expectedPayoutWallet,
      settledAmount: payeePortion,
      statusCode: payeePortion === 0n ? 5 : 3,
      timestamp: Math.floor(Date.now() / 1000)
    });

    setSim((prev) => {
      const nextBalances = { ...prev.balances };
      nextBalances.escrowVault = (nextBalances.escrowVault || 0n) - inv.amount;
      nextBalances[SIM_ADDRESSES.buyer] = (nextBalances[SIM_ADDRESSES.buyer] || 0n) + buyerRefund;
      for (const leg of computedSplits) {
        nextBalances[leg.expectedWallet] = (nextBalances[leg.expectedWallet] || 0n) + leg.computedAmount;
      }
      return {
        ...prev,
        balances: nextBalances,
        invoices: prev.invoices.map((x) =>
          x.id === invoiceId ? { ...x, status: nextStatus, receiptHash, lastBlockReason: null } : x
        ),
        auditLog: [
          {
            id: `log-${Date.now()}`,
            time: new Date().toLocaleTimeString(),
            kind: "SUCCESS",
            title: `Arbiter Resolved Dispute #${invoiceId} (${refundBps / 100}% Buyer Refund)`,
            detail: `Buyer +${formatTUSD8(buyerRefund)} tUSD8 | Payee Splits +${formatTUSD8(payeePortion)} tUSD8 · 0 dust`
          },
          ...prev.auditLog
        ]
      };
    });
  };

  // Emergency Refund if Payee Revoked Post-Funding
  const handleEmergencyRefundSim = (invoiceId) => {
    const inv = sim.invoices.find((i) => i.id === invoiceId);
    if (!inv || (inv.status !== "FUNDED" && inv.status !== "DISPUTED")) return;
    const primary = sim.payees.find((p) => p.agentId === inv.payeeAgentId);
    if (!primary || !primary.revoked) return;

    const receiptHash = computeReceiptHash({
      invoiceId: inv.id,
      payer: SIM_ADDRESSES.buyer,
      payeeAgentId: inv.payeeAgentId,
      expectedHandleHash: hashText(inv.expectedHandle),
      expectedLegalHash: hashText(inv.expectedLegalName),
      expectedPayoutWallet: inv.expectedPayoutWallet,
      settledAmount: 0n,
      statusCode: 5,
      timestamp: Math.floor(Date.now() / 1000)
    });

    setSim((prev) => {
      const nextBalances = { ...prev.balances };
      nextBalances.escrowVault = (nextBalances.escrowVault || 0n) - inv.amount;
      nextBalances[SIM_ADDRESSES.buyer] = (nextBalances[SIM_ADDRESSES.buyer] || 0n) + inv.amount;
      return {
        ...prev,
        balances: nextBalances,
        invoices: prev.invoices.map((x) =>
          x.id === invoiceId ? { ...x, status: "REFUNDED", receiptHash, lastBlockReason: null } : x
        ),
        auditLog: [
          {
            id: `log-${Date.now()}`,
            time: new Date().toLocaleTimeString(),
            kind: "SUCCESS",
            title: `Emergency Revocation Refund Executed (#${invoiceId})`,
            detail: `100% of ${formatTUSD8(inv.amount)} tUSD8 reclaimed by buyer after ERC-8004 #${inv.payeeAgentId} revocation.`
          },
          ...prev.auditLog
        ]
      };
    });
  };

  // Download deterministic cryptographic settlement receipt JSON
  const downloadReceipt = (inv) => {
    const computedSplits = computeDustFreeSplits(inv.amount, inv.splits).map((s) => ({
      agentId: s.agentId,
      handle: s.handle,
      wallet: s.expectedWallet,
      bps: s.bps,
      amountRaw6dp: s.computedAmount.toString(),
      amountTUSD8: formatTUSD8(s.computedAmount)
    }));
    const payload = {
      protocol: "PayeeShield v1.0",
      network: AEVUM_NETWORK.chainName,
      chainId: AEVUM_NETWORK.chainIdDecimal,
      token: { symbol: "tUSD8", decimals: 6, contract: AEVUM_NETWORK.contracts.tUSD8 },
      invoiceId: inv.id,
      reference: inv.reference,
      status: inv.status,
      payee: {
        erc8004AgentId: inv.payeeAgentId,
        handle: inv.expectedHandle,
        handleHash: hashText(inv.expectedHandle),
        legalEntityName: inv.expectedLegalName,
        legalEntityHash: hashText(inv.expectedLegalName),
        verifiedPayoutWallet: inv.expectedPayoutWallet
      },
      totalAmountTUSD8: formatTUSD8(inv.amount),
      splits: computedSplits,
      receiptHash: inv.receiptHash,
      exportedAt: new Date().toISOString()
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `payeeshield-receipt-${inv.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Issue new invoice handler
  const bpsSum = invSplits.reduce((acc, s) => acc + Number(s.bps || 0), 0);
  const parsedIssueAmount = parseTUSD8(invAmountStr);
  const previewSplits = useMemo(() => {
    if (parsedIssueAmount <= 0n || bpsSum !== 10000) return [];
    const hydrated = invSplits.map((leg) => {
      const p = sim.payees.find((x) => x.agentId === Number(leg.agentId));
      return {
        ...leg,
        handle: p?.handle || `agent#${leg.agentId}`,
        expectedWallet: p?.payoutWallet || ethers.ZeroAddress
      };
    });
    return computeDustFreeSplits(parsedIssueAmount, hydrated);
  }, [parsedIssueAmount, bpsSum, invSplits, sim.payees]);

  const handleIssueInvoice = (e) => {
    e.preventDefault();
    setIssueError("");
    const merchant = sim.payees.find((p) => p.agentId === Number(invMerchantId));
    if (!merchant || merchant.revoked) {
      setIssueError("Selected primary merchant is revoked or invalid.");
      return;
    }
    if (parsedIssueAmount <= 0n) {
      setIssueError("Amount must be greater than 0 tUSD8.");
      return;
    }
    if (bpsSum !== 10000) {
      setIssueError(`Split BPS sum is ${bpsSum}; Solidity enforces exact sum == 10,000.`);
      return;
    }
    if (invSplits.some((s) => Number(s.bps) <= 0)) {
      setIssueError("Every split leg must be > 0 bps.");
      return;
    }

    const hydratedSplits = invSplits.map((leg) => {
      const p = sim.payees.find((x) => x.agentId === Number(leg.agentId));
      return {
        agentId: p.agentId,
        handle: p.handle,
        expectedWallet: p.payoutWallet,
        bps: Number(leg.bps),
        role: leg.role || "Verified Split Leg"
      };
    });

    if (hydratedSplits.some((leg) => sim.payees.find((p) => p.agentId === leg.agentId)?.revoked)) {
      setIssueError("Cannot include a revoked ERC-8004 payee in split recipients.");
      return;
    }

    const newId = sim.nextInvoiceId;
    const now = Math.floor(Date.now() / 1000);
    const created = {
      id: newId,
      reference: invRef.trim() || `INV-2026-${newId}`,
      description: invDesc.trim() || "CoP-Verified B2B Invoice",
      payeeAgentId: merchant.agentId,
      expectedHandle: merchant.handle,
      expectedLegalName: merchant.legalName,
      expectedPayoutWallet: merchant.payoutWallet,
      amount: parsedIssueAmount,
      mode: invMode,
      status: "OPEN",
      requireAttestation: invRequireKyb,
      strictNoPendingRotation: invStrictRotation,
      disputeWindowSec: invMode === "MILESTONE_ESCROW" ? Number(invDisputeHours) * 3600 : 0,
      expiresAt: now + 86400 * 3,
      splits: hydratedSplits,
      receiptHash: null,
      lastBlockReason: null
    };

    setSim((prev) => ({
      ...prev,
      nextInvoiceId: prev.nextInvoiceId + 1,
      invoices: [created, ...prev.invoices],
      auditLog: [
        {
          id: `log-${Date.now()}`,
          time: new Date().toLocaleTimeString(),
          kind: "INFO",
          title: `Issued Invoice #${newId} (${formatTUSD8(parsedIssueAmount)} tUSD8)`,
          detail: `Bound to ERC-8004 #${merchant.agentId} (${merchant.handle}) · ${hydratedSplits.length} verified split leg(s)`
        },
        ...prev.auditLog
      ]
    }));
    setInvRef(`INV-2026-Q4-0${newId + 1}`);
    setActiveTab("invoices");
  };

  // Registry Actions
  const handleRegisterPayeeSim = (e) => {
    e.preventDefault();
    setRegMessage(null);
    const check = validateAndNormalizeHandle(newHandle);
    if (!check.ok) {
      setRegMessage({ ok: false, text: `REVERT InvalidHandle(): ${check.reason}` });
      return;
    }
    if (sim.payees.some((p) => p.handle === check.normalized)) {
      setRegMessage({ ok: false, text: `REVERT HandleAlreadyRegistered('${check.normalized}')` });
      return;
    }
    if (!newLegal.trim()) {
      setRegMessage({ ok: false, text: "Legal entity / business name is required." });
      return;
    }
    if (!ethers.isAddress(newWalletAddr)) {
      setRegMessage({ ok: false, text: "Enter a valid EVM payout address (0x...)." });
      return;
    }

    const id = sim.nextAgentId;
    const entry = {
      agentId: id,
      handle: check.normalized,
      handleHash: check.handleHash,
      legalName: newLegal.trim(),
      legalEntityHash: hashText(newLegal.trim()),
      payoutWallet: ethers.getAddress(newWalletAddr),
      pendingPayoutWallet: null,
      rotationExecutableAt: 0,
      agentURI: `ipfs://bafybeig-${check.normalized.replace(/\./g, "-")}-erc8004.json`,
      kybAttested: true,
      attesterLabel: "Aevum KYB Registry #01",
      revoked: false,
      revocationReason: ""
    };

    setSim((prev) => ({
      ...prev,
      nextAgentId: prev.nextAgentId + 1,
      payees: [...prev.payees, entry],
      balances: { ...prev.balances, [entry.payoutWallet]: prev.balances[entry.payoutWallet] || 0n }
    }));
    appendLog("SUCCESS", `Minted ERC-8004 Payee #${id} (${entry.handle})`, `Bound ${shortAddr(entry.payoutWallet)} with strict ASCII normalization.`);
    setRegMessage({ ok: true, text: `Minted ERC-8004 Identity NFT #${id} for '${entry.handle}'.` });
    setNewHandle("");
    setNewLegal("");
  };

  const toggleRevokeSim = (agentId) => {
    setSim((prev) => ({
      ...prev,
      payees: prev.payees.map((p) =>
        p.agentId === agentId
          ? {
              ...p,
              revoked: true,
              pendingPayoutWallet: null,
              revocationReason: "GUARDIAN_EMERGENCY_REVOCATION"
            }
          : p
      )
    }));
    appendLog("WARN", `Guardian Revoked ERC-8004 Payee #${agentId}`, "All future payments hard-blocked; funded escrows unlocked for 100% emergency buyer refund.");
  };

  const toggleRotationSim = (agentId) => {
    setSim((prev) => ({
      ...prev,
      payees: prev.payees.map((p) =>
        p.agentId === agentId
          ? {
              ...p,
              pendingPayoutWallet: p.pendingPayoutWallet ? null : SIM_ADDRESSES.rotatedWallet,
              rotationExecutableAt: p.pendingPayoutWallet ? 0 : Math.floor(Date.now() / 1000) + 3600
            }
          : p
      )
    }));
    appendLog("INFO", `Toggled 1h Timelocked Wallet Rotation on ERC-8004 #${agentId}`, "Demonstrates CoP WALLET_ROTATION_PENDING guard during cooldown.");
  };

  const resetDemo = () => {
    setSim(createInitialSimState());
    applyPreset("exact");
  };

  const verdictTone =
    simCopEval.status === COP_STATUS.EXACT_MATCH
      ? "verdict-pass"
      : simCopEval.status === COP_STATUS.CLOSE_MATCH_WARNING || simCopEval.status === COP_STATUS.WALLET_ROTATION_PENDING
        ? "verdict-warn"
        : "verdict-block";

  return (
    <div className="app-shell">
      {/* Top Bar */}
      <header className="topbar">
        <div className="brand">
          <div className="brand-icon" aria-hidden="true">
            <ShieldCheck size={22} />
          </div>
          <div>
            <h1 className="brand-title">
              PayeeShield
              <span className="badge badge-cyan mono">ERC-8004 × tUSD8</span>
            </h1>
            <p className="brand-sub">
              On-Chain Confirmation-of-Payee &amp; Multi-Split Merchant Escrow · QDay Aevum Testnet (Chain ID 44005)
            </p>
          </div>
        </div>

        <div className="topbar-controls">
          <div className="mode-switch" role="group" aria-label="Execution Mode">
            <button
              type="button"
              className={`mode-btn ${mode === "sim" ? "active-sim" : ""}`}
              onClick={() => setMode("sim")}
            >
              <Sparkles size={14} /> Interactive Simulation
            </button>
            <button
              type="button"
              className={`mode-btn ${mode === "live" ? "active-live" : ""}`}
              onClick={() => setMode("live")}
            >
              <Wallet size={14} /> Aevum Live (44005)
            </button>
          </div>

          {mode === "sim" ? (
            <button type="button" className="btn btn-sm" onClick={resetDemo} title="Reset simulation state">
              <RefreshCw size={14} /> Reset Demo
            </button>
          ) : (
            <button type="button" className="btn btn-cyan btn-sm" onClick={wallet.connect} disabled={wallet.connecting}>
              <Wallet size={14} />
              {wallet.account
                ? `${shortAddr(wallet.account)} ${wallet.isOnAevum ? "✓ 44005" : "Switch 44005"}`
                : wallet.connecting
                  ? "Connecting…"
                  : "Connect Aevum Wallet"}
            </button>
          )}
        </div>
      </header>

      {/* Live Network Info Banner */}
      {mode === "live" && (
        <section className="network-banner">
          <div>
            <strong>QDay Aevum Testnet (Chain ID 44005)</strong> · RPC{" "}
            <span className="mono">{AEVUM_NETWORK.rpcUrl}</span> · Official{" "}
            <a
              href={`${AEVUM_NETWORK.explorerUrl}/address/${AEVUM_NETWORK.contracts.tUSD8}`}
              target="_blank"
              rel="noreferrer"
              className="mono"
            >
              tUSD8 ({shortAddr(AEVUM_NETWORK.contracts.tUSD8)}) <ExternalLink size={12} />
            </a>
            {wallet.account && (
              <div className="mono" style={{ marginTop: 4, color: "#a7f3d0" }}>
                Connected: {wallet.account} · Gas: {wallet.tQdayBalance ? `${Number(wallet.tQdayBalance).toFixed(4)} tQDAY` : "—"} ·{" "}
                tUSD8: {wallet.tUsd8Balance !== null ? `${formatTUSD8(wallet.tUsd8Balance)} tUSD8` : "Switch to 44005"}
              </div>
            )}
            {wallet.error && (
              <div style={{ marginTop: 4, color: "#fca5a5" }}>{wallet.error}</div>
            )}
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input
              className="input mono"
              style={{ width: 220, padding: "6px 10px", fontSize: "0.75rem" }}
              placeholder="Registry 0x... (44005)"
              value={liveRegistryAddr}
              onChange={(e) => setLiveRegistryAddr(e.target.value)}
            />
            <input
              className="input mono"
              style={{ width: 220, padding: "6px 10px", fontSize: "0.75rem" }}
              placeholder="Escrow 0x... (44005)"
              value={liveEscrowAddr}
              onChange={(e) => setLiveEscrowAddr(e.target.value)}
            />
            <a href={AEVUM_NETWORK.faucetUrl} target="_blank" rel="noreferrer" className="btn btn-sm">
              Aevum Faucet <ExternalLink size={12} />
            </a>
          </div>
        </section>
      )}

      {/* KPI Strip */}
      <section className="kpi-grid" aria-label="Protocol Metrics">
        <div className="kpi-card">
          <div className="kpi-label">
            <span>Buyer Treasury (tUSD8)</span>
            <span className="badge badge-emerald">6dp</span>
          </div>
          <div className="kpi-value mono">{formatTUSD8(kpis.buyerBal)}</div>
          <div className="kpi-sub mono">{shortAddr(SIM_ADDRESSES.buyer)}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">
            <span>Active Escrow Vault</span>
            <Lock size={14} color="#38bdf8" />
          </div>
          <div className="kpi-value mono">{formatTUSD8(kpis.escrowBal)}</div>
          <div className="kpi-sub">Protected by post-funding revocation exit</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">
            <span>Verified ERC-8004 Payees</span>
            <Users size={14} color="#10b981" />
          </div>
          <div className="kpi-value mono">
            {kpis.activePayees} / {kpis.totalPayees}
          </div>
          <div className="kpi-sub">
            Strict ASCII handles · {kpis.totalPayees - kpis.activePayees} revoked kill-switch
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">
            <span>Spoofs Blocked / Settled</span>
            <ShieldAlert size={14} color="#f59e0b" />
          </div>
          <div className="kpi-value mono">
            {kpis.blockedAttempts} Blocked · {kpis.settledCount} Settled
          </div>
          <div className="kpi-sub">0.000000 tUSD8 leaked · 0 wei split dust</div>
        </div>
      </section>

      {/* Navigation Tabs */}
      <nav className="tab-bar" role="tablist" aria-label="PayeeShield Modules">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={activeTab === id}
            className={`tab-btn ${activeTab === id ? "active" : ""}`}
            onClick={() => setActiveTab(id)}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </nav>

      {/* TAB 1: CONFIRMATION-OF-PAYEE INSPECTOR */}
      {activeTab === "cop" && (
        <section className="grid-2">
          <div className="card">
            <h2 className="card-title">
              <ShieldCheck size={19} color="#10b981" /> Pre-Flight Confirmation-of-Payee (CoP) Shield
            </h2>
            <p className="card-desc">
              Test how <span className="mono">ERC8004PayeeRegistry.verifyPayeeByHandle</span> stops Business Email
              Compromise (BEC), typosquat lookalikes, Cyrillic homoglyphs, and revoked wallets before a single base unit
              of <span className="mono">tUSD8</span> moves.
            </p>

            <div className="preset-row" aria-label="One-Click Judge Scenarios">
              <button type="button" className="preset-chip" onClick={() => applyPreset("exact")}>
                <CheckCircle2 size={14} color="#10b981" /> Exact Match (acme.cloud)
              </button>
              <button type="button" className="preset-chip" onClick={() => applyPreset("close")}>
                <AlertTriangle size={14} color="#f59e0b" /> Close Match (Entity Diff)
              </button>
              <button type="button" className="preset-chip" onClick={() => applyPreset("spoof")}>
                <XCircle size={14} color="#ef4444" /> Lookalike Spoof (acrne.cloud)
              </button>
              <button type="button" className="preset-chip" onClick={() => applyPreset("homoglyph")}>
                <Ban size={14} color="#ef4444" /> Cyrillic Homoglyph (аcme.cloud)
              </button>
              <button type="button" className="preset-chip" onClick={() => applyPreset("revoked")}>
                <ShieldX size={14} color="#ef4444" /> Revoked Payee
              </button>
            </div>

            <div className="field">
              <label htmlFor="cop-handle">Expected Merchant / Agent Handle (ERC-8004)</label>
              <input
                id="cop-handle"
                className="input mono"
                value={copHandle}
                onChange={(e) => setCopHandle(e.target.value)}
                placeholder="e.g. acme.cloud"
              />
            </div>

            <div className="field">
              <label htmlFor="cop-legal">Expected Legal / Business Entity Name</label>
              <input
                id="cop-legal"
                className="input"
                value={copLegal}
                onChange={(e) => setCopLegal(e.target.value)}
                placeholder="e.g. Acme Cloud Infrastructure Ltd (SG-2026-8841)"
              />
            </div>

            <div className="field">
              <label htmlFor="cop-wallet">Target Payout Wallet Address (from Invoice / x402 Header)</label>
              <input
                id="cop-wallet"
                className="input mono"
                value={copWallet}
                onChange={(e) => setCopWallet(e.target.value)}
                placeholder="0x..."
              />
            </div>

            <div className="action-bar">
              {mode === "live" && (
                <>
                  <button type="button" className="btn btn-cyan" onClick={runLiveCoPCheck}>
                    Query Live Aevum RPC (44005)
                  </button>
                  <input
                    className="input mono"
                    style={{ width: 92, padding: "8px 10px" }}
                    value={liveInvoiceIdInput}
                    onChange={(e) => setLiveInvoiceIdInput(e.target.value)}
                    aria-label="Live Invoice ID"
                    title="On-chain Invoice ID"
                  />
                  <button type="button" className="btn btn-primary" onClick={runLivePayInvoice}>
                    Approve tUSD8 &amp; Pay Live Invoice
                  </button>
                </>
              )}
              <button type="button" className="btn btn-primary" onClick={() => setActiveTab("invoices")}>
                Proceed to CoP-Gated Invoice Queue →
              </button>
            </div>
            {liveStatusMsg && <div className="alert-banner amber">{liveStatusMsg}</div>}
          </div>

          <div className={`verdict-box ${verdictTone}`}>
            <div className="verdict-header">
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {simCopEval.status === COP_STATUS.EXACT_MATCH ? (
                  <ShieldCheck size={24} color="#10b981" />
                ) : simCopEval.status === COP_STATUS.CLOSE_MATCH_WARNING ||
                  simCopEval.status === COP_STATUS.WALLET_ROTATION_PENDING ? (
                  <ShieldAlert size={24} color="#f59e0b" />
                ) : (
                  <ShieldX size={24} color="#ef4444" />
                )}
                <div>
                  <div style={{ fontSize: "0.72rem", color: "#94a3b8", textTransform: "uppercase" }}>
                    On-Chain CoP Verdict
                  </div>
                  <div className="mono" style={{ fontSize: "1.05rem", fontWeight: 700 }} data-testid="cop-verdict">
                    {simCopEval.status}
                  </div>
                </div>
              </div>
              <span
                className={`badge ${
                  simCopEval.status === COP_STATUS.EXACT_MATCH
                    ? "badge-emerald"
                    : simCopEval.status === COP_STATUS.CLOSE_MATCH_WARNING ||
                        simCopEval.status === COP_STATUS.WALLET_ROTATION_PENDING
                      ? "badge-amber"
                      : "badge-crimson"
                }`}
              >
                {simCopEval.status === COP_STATUS.EXACT_MATCH ? "SETTLEMENT PERMITTED" : "HARD-REVERT PROTECTED"}
              </span>
            </div>

            <p style={{ margin: "0 0 10px", fontSize: "0.86rem" }}>{simCopEval.summary}</p>

            {simCopEval.lookalike && (
              <div className="alert-banner crimson">
                <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
                <div>
                  <strong>Lookalike Spoof Detected:</strong> Visual skeleton collides with verified merchant{" "}
                  <span className="mono">{simCopEval.lookalike.payee.handle}</span> (ERC-8004 #
                  {simCopEval.lookalike.payee.agentId}, verified wallet{" "}
                  <span className="mono">{shortAddr(simCopEval.lookalike.payee.payoutWallet)}</span>).
                </div>
              </div>
            )}

            <div className="kv-list">
              <div className="kv-row">
                <span>Solidity Gate Result</span>
                <span className="mono" style={{ color: simCopEval.revertError ? "#fca5a5" : "#6ee7b7" }}>
                  {simCopEval.revertError || "PASS (0 wei risk)"}
                </span>
              </div>
              <div className="kv-row">
                <span>Expected Handle Hash</span>
                <span className="mono">{shortHash(hashText(copHandle.toLowerCase()))}</span>
              </div>
              <div className="kv-row">
                <span>Expected Legal Hash</span>
                <span className="mono">{shortHash(hashText(copLegal.trim()))}</span>
              </div>
              <div className="kv-row">
                <span>Resolved ERC-8004 NFT</span>
                <span className="mono">
                  {simCopEval.matchedPayee ? `#${simCopEval.matchedPayee.agentId} (${simCopEval.matchedPayee.handle})` : "None"}
                </span>
              </div>
              <div className="kv-row">
                <span>KYB Attestation</span>
                <span className="mono">
                  {simCopEval.matchedPayee?.kybAttested ? "✓ ATTESTED (Aevum KYB #01)" : "✕ Unattested / Revoked"}
                </span>
              </div>
              <div className="kv-row">
                <span>EIP-712 Domain Chain ID</span>
                <span className="mono">44005 (QDay Aevum Testnet)</span>
              </div>
            </div>

            {liveCopResult && (
              <div className="alert-banner emerald" style={{ marginTop: 12 }}>
                <div>
                  <strong>Live RPC 44005 Response:</strong> {liveCopResult.status} · Agent #{liveCopResult.agentId} ·
                  Wallet {shortAddr(liveCopResult.activeWallet)}
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* TAB 2: INVOICE QUEUE & CO-P GATED SETTLEMENT */}
      {activeTab === "invoices" && (
        <section className="invoice-stack">
          {sim.invoices.map((inv) => {
            const payee = sim.payees.find((p) => p.agentId === inv.payeeAgentId);
            const liveCheck = evaluateCoP(sim.payees, {
              handle: inv.expectedHandle,
              legalName: inv.expectedLegalName,
              payoutWallet: inv.expectedPayoutWallet
            });
            const splitsPreview = computeDustFreeSplits(inv.amount, inv.splits);
            const sliderVal = refundSliders[inv.id] ?? 4000;

            return (
              <article
                key={inv.id}
                className={`invoice-card ${
                  inv.lastBlockReason || liveCheck.status !== COP_STATUS.EXACT_MATCH
                    ? inv.status === "OPEN"
                      ? "inv-blocked"
                      : ""
                    : ""
                } ${inv.status === "SETTLED" ? "inv-settled" : ""}`}
              >
                <div className="invoice-head">
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <strong className="mono">#{inv.id} · {inv.reference}</strong>
                      <span
                        className={`badge ${
                          inv.status === "SETTLED"
                            ? "badge-emerald"
                            : inv.status === "FUNDED"
                              ? "badge-cyan"
                              : inv.status === "DISPUTED"
                                ? "badge-amber"
                                : inv.status === "REFUNDED"
                                  ? "badge-slate"
                                  : "badge-slate"
                        }`}
                      >
                        {inv.status}
                      </span>
                      <span className="badge badge-cyan">{inv.mode === "INSTANT" ? "INSTANT SPLIT" : "MILESTONE ESCROW"}</span>
                      <span
                        className={`badge ${
                          liveCheck.status === COP_STATUS.EXACT_MATCH
                            ? "badge-emerald"
                            : liveCheck.status === COP_STATUS.WALLET_ROTATION_PENDING
                              ? "badge-amber"
                              : "badge-crimson"
                        }`}
                      >
                        CoP: {liveCheck.status}
                      </span>
                    </div>
                    <p style={{ margin: "6px 0 0", fontSize: "0.84rem", color: "#94a3b8" }}>{inv.description}</p>
                    <div className="mono" style={{ fontSize: "0.76rem", color: "#64748b", marginTop: 4 }}>
                      Payee: {inv.expectedHandle} (ERC-8004 #{inv.payeeAgentId}) · Invoice Wallet:{" "}
                      {shortAddr(inv.expectedPayoutWallet)}
                      {payee && payee.payoutWallet.toLowerCase() !== inv.expectedPayoutWallet.toLowerCase() && (
                        <span style={{ color: "#f87171" }}>
                          {" "}
                          ≠ Registry Wallet ({shortAddr(payee.payoutWallet)})
                        </span>
                      )}
                    </div>
                  </div>

                  <div style={{ textAlign: "right" }}>
                    <div className="mono" style={{ fontSize: "1.2rem", fontWeight: 700 }}>
                      {formatTUSD8(inv.amount)} <span style={{ fontSize: "0.8rem", color: "#38bdf8" }}>tUSD8</span>
                    </div>
                    <div style={{ fontSize: "0.74rem", color: "#64748b" }}>
                      {inv.requireAttestation ? "KYB Required" : "KYB Optional"} ·{" "}
                      {inv.strictNoPendingRotation ? "Strict Rotation Lock" : "Flex Rotation"}
                    </div>
                  </div>
                </div>

                {/* Dust-free split breakdown */}
                <div className="table-wrap">
                  <table className="split-table">
                    <thead>
                      <tr>
                        <th>Split Leg</th>
                        <th>ERC-8004 Payee</th>
                        <th>Target Wallet</th>
                        <th>Share (BPS)</th>
                        <th>Exact tUSD8 (0 Dust)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {splitsPreview.map((leg, idx) => (
                        <tr key={`${inv.id}-leg-${idx}`}>
                          <td>{leg.role}</td>
                          <td className="mono">
                            #{leg.agentId} · {leg.handle}
                          </td>
                          <td className="mono">{shortAddr(leg.expectedWallet)}</td>
                          <td className="mono">
                            {leg.bps} ({(leg.bps / 100).toFixed(2)}%)
                          </td>
                          <td className="mono">{formatTUSD8(leg.computedAmount)} tUSD8</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {inv.lastBlockReason && (
                  <div className="alert-banner crimson">
                    <ShieldX size={16} style={{ flexShrink: 0, marginTop: 2 }} />
                    <span className="mono">{inv.lastBlockReason}</span>
                  </div>
                )}

                {inv.receiptHash && (
                  <div className="alert-banner emerald">
                    <CheckCircle2 size={16} style={{ flexShrink: 0, marginTop: 2 }} />
                    <div style={{ flex: 1 }}>
                      <strong>Deterministic On-Chain Receipt Hash:</strong>{" "}
                      <span className="mono">{inv.receiptHash}</span>
                    </div>
                  </div>
                )}

                <div className="action-bar">
                  {inv.status === "OPEN" && (
                    <button
                      type="button"
                      className={`btn ${liveCheck.status === COP_STATUS.EXACT_MATCH ? "btn-primary" : "btn-danger"}`}
                      onClick={() => handlePayInvoiceSim(inv.id)}
                    >
                      {liveCheck.status === COP_STATUS.EXACT_MATCH ? (
                        <>
                          <ShieldCheck size={15} /> Verify CoP &amp; Pay {formatTUSD8(inv.amount)} tUSD8
                        </>
                      ) : (
                        <>
                          <ShieldAlert size={15} /> Attempt Payment (Watch CoP Gate Hard-Revert)
                        </>
                      )}
                    </button>
                  )}

                  {inv.status === "FUNDED" && (
                    <>
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => handleReleaseEscrowSim(inv.id)}>
                        <CheckCircle2 size={14} /> Buyer Confirm &amp; Release Splits
                      </button>
                      <button type="button" className="btn btn-amber btn-sm" onClick={() => handleOpenDisputeSim(inv.id)}>
                        <Scale size={14} /> Open Buyer Dispute
                      </button>
                      {payee && !payee.revoked ? (
                        <button type="button" className="btn btn-danger btn-sm" onClick={() => toggleRevokeSim(inv.payeeAgentId)}>
                          <Ban size={14} /> Simulate Post-Funding Payee Compromise (Revoke)
                        </button>
                      ) : (
                        <button type="button" className="btn btn-cyan btn-sm" onClick={() => handleEmergencyRefundSim(inv.id)}>
                          <ShieldCheck size={14} /> Execute Emergency 100% Buyer Refund
                        </button>
                      )}
                    </>
                  )}

                  {inv.status === "DISPUTED" && (
                    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, width: "100%" }}>
                      <label className="mono" style={{ fontSize: "0.78rem", color: "#fcd34d" }}>
                        Arbiter Refund: {(sliderVal / 100).toFixed(0)}% Buyer / {((10000 - sliderVal) / 100).toFixed(0)}% Splits
                      </label>
                      <input
                        type="range"
                        min={0}
                        max={10000}
                        step={500}
                        value={sliderVal}
                        onChange={(e) => setRefundSliders((p) => ({ ...p, [inv.id]: Number(e.target.value) }))}
                      />
                      <button
                        type="button"
                        className="btn btn-amber btn-sm"
                        onClick={() => handleResolveDisputeSim(inv.id, sliderVal)}
                      >
                        <Scale size={14} /> Arbiter Resolve Dispute
                      </button>
                      {payee?.revoked && (
                        <button type="button" className="btn btn-cyan btn-sm" onClick={() => handleEmergencyRefundSim(inv.id)}>
                          Emergency 100% Refund
                        </button>
                      )}
                    </div>
                  )}

                  {inv.receiptHash && (
                    <button type="button" className="btn btn-sm" onClick={() => downloadReceipt(inv)}>
                      <Download size={14} /> Export JSON Receipt
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </section>
      )}

      {/* TAB 3: ISSUE MULTI-SPLIT INVOICE */}
      {activeTab === "issue" && (
        <section className="grid-2">
          <form className="card" onSubmit={handleIssueInvoice}>
            <h2 className="card-title">
              <Split size={19} color="#38bdf8" /> Issue CoP-Bound tUSD8 Merchant Invoice
            </h2>
            <p className="card-desc">
              Lock the merchant's verified ERC-8004 handle, legal entity hash, active payout wallet, and up to 8
              verified BPS split recipients (exact sum <span className="mono">== 10,000</span>).
            </p>

            <div className="row-2">
              <div className="field">
                <label htmlFor="inv-merchant">Primary Verified Merchant (ERC-8004)</label>
                <select
                  id="inv-merchant"
                  className="select"
                  value={invMerchantId}
                  onChange={(e) => {
                    const nextId = Number(e.target.value);
                    setInvMerchantId(nextId);
                    setInvSplits((prev) => prev.map((leg, i) => (i === 0 ? { ...leg, agentId: nextId } : leg)));
                  }}
                >
                  {sim.payees
                    .filter((p) => !p.revoked)
                    .map((p) => (
                      <option key={p.agentId} value={p.agentId}>
                        #{p.agentId} · {p.handle} ({shortAddr(p.payoutWallet)})
                      </option>
                    ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="inv-amount">Invoice Amount (tUSD8 · 6 decimals)</label>
                <input
                  id="inv-amount"
                  className="input mono"
                  value={invAmountStr}
                  onChange={(e) => setInvAmountStr(e.target.value)}
                />
              </div>
            </div>

            <div className="row-2">
              <div className="field">
                <label htmlFor="inv-ref">Invoice Reference</label>
                <input id="inv-ref" className="input mono" value={invRef} onChange={(e) => setInvRef(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="inv-mode">Settlement Mode</label>
                <select id="inv-mode" className="select" value={invMode} onChange={(e) => setInvMode(e.target.value)}>
                  <option value="INSTANT">INSTANT — Atomic CoP Split Settlement</option>
                  <option value="MILESTONE_ESCROW">MILESTONE_ESCROW — Lock + Buyer Dispute Window</option>
                </select>
              </div>
            </div>

            <div className="field">
              <label htmlFor="inv-desc">Line Item Description</label>
              <input id="inv-desc" className="input" value={invDesc} onChange={(e) => setInvDesc(e.target.value)} />
            </div>

            {invMode === "MILESTONE_ESCROW" && (
              <div className="field">
                <label htmlFor="inv-dispute">Buyer Dispute Window (hours)</label>
                <input
                  id="inv-dispute"
                  type="number"
                  min={1}
                  max={720}
                  className="input mono"
                  value={invDisputeHours}
                  onChange={(e) => setInvDisputeHours(Number(e.target.value))}
                />
              </div>
            )}

            <div className="checkbox-row">
              <label>
                <input type="checkbox" checked={invRequireKyb} onChange={(e) => setInvRequireKyb(e.target.checked)} />
                Require Active KYB Attestation
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={invStrictRotation}
                  onChange={(e) => setInvStrictRotation(e.target.checked)}
                />
                Block During Wallet Rotation Cooldown
              </label>
            </div>

            <div style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <strong style={{ fontSize: "0.84rem" }}>Multi-Party BPS Splits (Every Leg ERC-8004 Verified)</strong>
                <span className={`badge mono ${bpsSum === 10000 ? "badge-emerald" : "badge-crimson"}`}>
                  Sum: {bpsSum} / 10000 bps
                </span>
              </div>

              {invSplits.map((leg, idx) => (
                <div
                  key={`edit-leg-${idx}`}
                  style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 0.7fr auto", gap: 8, marginBottom: 8 }}
                >
                  <select
                    className="select"
                    value={leg.agentId}
                    onChange={(e) =>
                      setInvSplits((prev) =>
                        prev.map((x, i) => (i === idx ? { ...x, agentId: Number(e.target.value) } : x))
                      )
                    }
                  >
                    {sim.payees
                      .filter((p) => !p.revoked)
                      .map((p) => (
                        <option key={p.agentId} value={p.agentId}>
                          #{p.agentId} · {p.handle}
                        </option>
                      ))}
                  </select>
                  <input
                    className="input"
                    value={leg.role}
                    onChange={(e) =>
                      setInvSplits((prev) => prev.map((x, i) => (i === idx ? { ...x, role: e.target.value } : x)))
                    }
                    placeholder="Role"
                  />
                  <input
                    type="number"
                    className="input mono"
                    min={1}
                    max={10000}
                    value={leg.bps}
                    onChange={(e) =>
                      setInvSplits((prev) =>
                        prev.map((x, i) => (i === idx ? { ...x, bps: Number(e.target.value) } : x))
                      )
                    }
                  />
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    disabled={invSplits.length <= 1}
                    onClick={() => setInvSplits((prev) => prev.filter((_, i) => i !== idx))}
                    aria-label="Remove split leg"
                  >
                    ✕
                  </button>
                </div>
              ))}

              {invSplits.length < 8 && (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() =>
                    setInvSplits((prev) => [...prev, { agentId: 2, bps: Math.max(0, 10000 - bpsSum), role: "Tax / Split Leg" }])
                  }
                >
                  <Plus size={14} /> Add Verified Split Leg
                </button>
              )}
            </div>

            {issueError && <div className="alert-banner crimson">{issueError}</div>}

            <div className="action-bar">
              <button type="submit" className="btn btn-primary" disabled={bpsSum !== 10000 || parsedIssueAmount <= 0n}>
                <FileText size={15} /> Create CoP-Bound Invoice
              </button>
            </div>
          </form>

          <div className="card">
            <h2 className="card-title">Dust-Free Split Settlement Preview</h2>
            <p className="card-desc">
              Solidity assigns any integer division remainder (<span className="mono">amount - distributed</span>) to
              the final split leg so <strong className="mono">0 wei</strong> is ever trapped in the contract.
            </p>
            {previewSplits.length > 0 ? (
              <table className="split-table">
                <thead>
                  <tr>
                    <th>Role</th>
                    <th>Payee</th>
                    <th>BPS</th>
                    <th>Exact Payout</th>
                  </tr>
                </thead>
                <tbody>
                  {previewSplits.map((leg, i) => (
                    <tr key={`prev-${i}`}>
                      <td>{leg.role}</td>
                      <td className="mono">{leg.handle}</td>
                      <td className="mono">{leg.bps}</td>
                      <td className="mono">{formatTUSD8(leg.computedAmount)} tUSD8</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="alert-banner amber">Adjust BPS legs to equal exactly 10,000 bps to preview exact settlement amounts.</div>
            )}
          </div>
        </section>
      )}

      {/* TAB 4: ERC-8004 IDENTITY REGISTRY */}
      {activeTab === "registry" && (
        <section className="grid-2">
          <div className="card">
            <h2 className="card-title">
              <Users size={19} color="#10b981" /> ERC-8004 Payee Identities
            </h2>
            <p className="card-desc">
              Each payee is an ERC-721 identity NFT with normalized ASCII handle, timelocked payout wallet rotation,
              transfer-safe wallet auto-reset, and guardian emergency revocation.
            </p>
            <div className="table-wrap">
              <table className="split-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Handle &amp; Entity</th>
                    <th>Active Wallet</th>
                    <th>Status</th>
                    <th>Controls</th>
                  </tr>
                </thead>
                <tbody>
                  {sim.payees.map((p) => (
                    <tr key={p.agentId}>
                      <td className="mono">#{p.agentId}</td>
                      <td>
                        <div className="mono" style={{ fontWeight: 600 }}>
                          {p.handle}
                        </div>
                        <div style={{ fontSize: "0.73rem", color: "#94a3b8" }}>{p.legalName}</div>
                      </td>
                      <td className="mono">
                        {p.revoked ? "0x0000…0000" : shortAddr(p.payoutWallet)}
                        {p.pendingPayoutWallet && (
                          <div style={{ fontSize: "0.71rem", color: "#f59e0b" }}>
                            → {shortAddr(p.pendingPayoutWallet)} (1h lock)
                          </div>
                        )}
                      </td>
                      <td>
                        {p.revoked ? (
                          <span className="badge badge-crimson">REVOKED</span>
                        ) : p.pendingPayoutWallet ? (
                          <span className="badge badge-amber">ROTATING</span>
                        ) : (
                          <span className="badge badge-emerald">VERIFIED</span>
                        )}
                      </td>
                      <td>
                        {!p.revoked && (
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            <button
                              type="button"
                              className="btn btn-sm btn-amber"
                              onClick={() => toggleRotationSim(p.agentId)}
                              title="Simulate timelocked payout wallet rotation"
                            >
                              <Clock size={12} /> {p.pendingPayoutWallet ? "Cancel Rot." : "Rotate"}
                            </button>
                            <button
                              type="button"
                              className="btn btn-sm btn-danger"
                              onClick={() => toggleRevokeSim(p.agentId)}
                              title="Guardian emergency revocation"
                            >
                              <Ban size={12} /> Revoke
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <form className="card" onSubmit={handleRegisterPayeeSim}>
            <h2 className="card-title">Mint New ERC-8004 Payee Identity</h2>
            <p className="card-desc">
              Enforces strict lowercase ASCII (<span className="mono">[a-z0-9._-]</span>) to block Unicode homoglyph
              registration attacks at the Solidity contract layer.
            </p>
            <div className="field">
              <label htmlFor="reg-handle">Payee Handle</label>
              <input
                id="reg-handle"
                className="input mono"
                value={newHandle}
                onChange={(e) => setNewHandle(e.target.value)}
                placeholder="e.g. solaris.logistics"
              />
            </div>
            <div className="field">
              <label htmlFor="reg-legal">Verified Legal / Business Name</label>
              <input
                id="reg-legal"
                className="input"
                value={newLegal}
                onChange={(e) => setNewLegal(e.target.value)}
                placeholder="e.g. Solaris Logistics GmbH (DE-99210)"
              />
            </div>
            <div className="field">
              <label htmlFor="reg-wallet">Bound Payout Wallet (ERC-8004 agentWallet)</label>
              <input
                id="reg-wallet"
                className="input mono"
                value={newWalletAddr}
                onChange={(e) => setNewWalletAddr(e.target.value)}
              />
            </div>
            {regMessage && (
              <div className={`alert-banner ${regMessage.ok ? "emerald" : "crimson"}`}>{regMessage.text}</div>
            )}
            <div className="action-bar">
              <button type="submit" className="btn btn-primary">
                <Plus size={15} /> Register ERC-8004 Payee
              </button>
            </div>
          </form>
        </section>
      )}

      {/* Live Security & Settlement Audit Ledger */}
      <section className="audit-panel" aria-label="Security & Settlement Audit Trail">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <strong style={{ fontSize: "0.86rem" }}>Real-Time CoP Security &amp; Settlement Audit Trail</strong>
          <span className="mono" style={{ fontSize: "0.74rem", color: "#64748b" }}>
            {sim.auditLog.length} event(s)
          </span>
        </div>
        <div className="audit-list">
          {sim.auditLog.map((item) => (
            <div key={item.id} className="audit-item">
              <div>
                <span
                  className={`badge ${
                    item.kind === "SUCCESS"
                      ? "badge-emerald"
                      : item.kind === "BLOCKED"
                        ? "badge-crimson"
                        : item.kind === "WARN"
                          ? "badge-amber"
                          : "badge-cyan"
                  }`}
                  style={{ marginRight: 8 }}
                >
                  {item.kind}
                </span>
                <strong>{item.title}</strong>
                <div className="mono" style={{ fontSize: "0.75rem", color: "#94a3b8", marginTop: 3 }}>
                  {item.detail}
                </div>
              </div>
              <span className="mono" style={{ color: "#64748b", fontSize: "0.73rem" }}>
                {item.time}
              </span>
            </div>
          ))}
        </div>
      </section>

      <footer className="footer">
        <div>
          <strong>PayeeShield</strong> — Built for Aevum Builder Challenge #1 (Confirmation of Payee + Invoice Payments)
        </div>
        <div className="mono">
          Aevum Testnet 44005 ·{" "}
          <a href={`${AEVUM_NETWORK.explorerUrl}/address/${AEVUM_NETWORK.contracts.tUSD8}`} target="_blank" rel="noreferrer">
            tUSD8 Explorer
          </a>{" "}
          ·{" "}
          <a href={AEVUM_NETWORK.faucetUrl} target="_blank" rel="noreferrer">
            tQDAY / tUSD8 Faucet
          </a>
        </div>
      </footer>
    </div>
  );
}
