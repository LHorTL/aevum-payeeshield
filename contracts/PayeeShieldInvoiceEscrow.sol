// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC8004PayeeRegistry} from "./interfaces/IERC8004PayeeRegistry.sol";

/**
 * @title PayeeShieldInvoiceEscrow
 * @notice tUSD8 B2B & AI-Agent Merchant Invoice and Multi-Party Split Escrow enforcing
 *         mandatory on-chain ERC-8004 Confirmation-of-Payee (CoP) before a single unit
 *         of tUSD8 moves.
 * @dev    Features:
 *         - Atomic pre-settlement Confirmation-of-Payee gate (Exact Match required; hard-reverts
 *           on Mismatch, Close-Match legal entity mismatch, Revoked Payee, or Pending Rotation).
 *         - Supports both Instant CoP Settlement and Milestone Escrow with buyer dispute window.
 *         - Multi-recipient BPS splits (sum == 10,000, dust-free remainder allocation, every
 *           split recipient bound to an active non-revoked ERC-8004 payee identity).
 *         - Optional EIP-712 signed CoP verification receipt bound to `(address(this), invoiceId, salt)`
 *           with one-time replay protection.
 *         - Zero-stuck-funds buyer emergency refund if a funded primary payee OR any split leg is
 *           revoked, rotated to another wallet, transferred, or changes profile post-funding
 *           (callable even while paused and even after `disputeDeadline`).
 *         - `openDispute` intentionally callable even while paused so buyers can never be timed out.
 */
contract PayeeShieldInvoiceEscrow is ReentrancyGuard, Pausable, AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant ARBITER_ROLE = keccak256("ARBITER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_SPLITS = 8;
    uint64 public constant MAX_DISPUTE_WINDOW = 30 days;

    IERC20 public immutable paymentToken;
    IERC8004PayeeRegistry public immutable payeeRegistry;

    enum SettlementMode {
        INSTANT,
        MILESTONE_ESCROW
    }

    enum InvoiceStatus {
        NONE,
        OPEN,
        FUNDED,
        SETTLED,
        DISPUTED,
        REFUNDED,
        CANCELLED,
        EXPIRED
    }

    /**
     * @notice One payout leg of a multi-party split.
     * @param agentId        ERC-8004 identity ID of this split recipient (MUST be non-zero and active).
     * @param expectedWallet Expected payout wallet verified against `payeeRegistry.getAgentWallet(agentId)`.
     * @param bps            Share in basis points (1..10000). Sum across all legs MUST equal 10,000.
     */
    struct SplitRecipient {
        uint256 agentId;
        address expectedWallet;
        uint16 bps;
    }

    struct CreateInvoiceParams {
        uint256 payeeAgentId;
        bytes32 expectedHandleHash;
        bytes32 expectedLegalHash;
        address expectedPayoutWallet;
        address restrictedBuyer;
        uint256 amount;
        uint64 expiresAt;
        uint64 disputeWindow;
        SettlementMode mode;
        bool requireAttestation;
        bool strictNoPendingRotation;
        bytes32 metadataHash;
    }

    struct Invoice {
        uint256 id;
        address issuer;
        uint256 payeeAgentId;
        bytes32 expectedHandleHash;
        bytes32 expectedLegalHash;
        address expectedPayoutWallet;
        address restrictedBuyer;
        address payer;
        uint256 amount;
        uint64 createdAt;
        uint64 expiresAt;
        uint64 disputeWindow;
        uint64 disputeDeadline;
        SettlementMode mode;
        InvoiceStatus status;
        bool requireAttestation;
        bool strictNoPendingRotation;
        bytes32 metadataHash;
        bytes32 receiptHash;
        bytes32 disputeReasonHash;
    }

    uint256 private _nextInvoiceId = 1;
    mapping(uint256 => Invoice) private _invoices;
    mapping(uint256 => SplitRecipient[]) private _invoiceSplits;
    mapping(bytes32 => bool) public usedCoPReceipts;

    // ---- Events ----
    event InvoiceCreated(
        uint256 indexed invoiceId,
        uint256 indexed payeeAgentId,
        address indexed expectedPayoutWallet,
        uint256 amount,
        SettlementMode mode,
        uint64 expiresAt,
        uint256 splitCount
    );
    event InvoiceFunded(
        uint256 indexed invoiceId,
        address indexed payer,
        uint256 indexed payeeAgentId,
        uint256 amount,
        uint64 disputeDeadline,
        bytes32 fundingReceiptHash
    );
    event InvoiceSettled(
        uint256 indexed invoiceId,
        address indexed payer,
        uint256 indexed payeeAgentId,
        uint256 totalDistributed,
        bytes32 receiptHash
    );
    event SplitDistributed(
        uint256 indexed invoiceId,
        uint256 indexed recipientAgentId,
        address indexed recipientWallet,
        uint256 amount,
        uint16 bps
    );
    event DisputeOpened(uint256 indexed invoiceId, address indexed payer, bytes32 reasonHash);
    event DisputeResolved(
        uint256 indexed invoiceId,
        address indexed arbiter,
        uint256 buyerRefundAmount,
        uint256 payeeDistributedAmount,
        bytes32 receiptHash
    );
    event EmergencyRefundIssued(uint256 indexed invoiceId, address indexed payer, uint256 amount, uint256 invalidatedAgentId);
    event InvoiceCancelled(uint256 indexed invoiceId, address indexed cancelledBy);
    event InvoiceExpiredEvent(uint256 indexed invoiceId);

    // ---- Custom Errors ----
    error ZeroAddress();
    error InvalidAmount();
    error InvalidExpiry();
    error InvalidDisputeWindow();
    error InvalidCoPHash();
    error InvalidSplits();
    error SplitBpsSumMismatch(uint256 actualSum);
    error UnauthorizedIssuer();
    error InvoiceNotFound(uint256 invoiceId);
    error InvoiceExpired(uint256 invoiceId);
    error AlreadySettled(uint256 invoiceId);
    error InvalidStatus(InvoiceStatus expected, InvoiceStatus actual);
    error UnauthorizedCaller();
    error UnauthorizedBuyer();
    error PayeeMismatch(IERC8004PayeeRegistry.CoPStatus status);
    error PayeeRevoked(uint256 agentId);
    error PayeeUnattested(uint256 agentId);
    error PayeeRotationPending(uint256 agentId);
    error SplitPayeeCheckFailed(uint256 index, uint256 agentId);
    error BuyerExpectationMismatch();
    error InvalidCoPSignature();
    error CoPReceiptAlreadyUsed(bytes32 digest);
    error DisputeWindowActive(uint64 deadline);
    error DisputeWindowClosed(uint64 deadline);
    error InvalidRefundBps(uint16 bps);
    error PayeeStillValid();
    error InvoiceNotExpiredYet(uint64 expiresAt);

    constructor(address _paymentToken, address _payeeRegistry, address admin, address arbiter) {
        if (_paymentToken == address(0) || _payeeRegistry == address(0) || admin == address(0) || arbiter == address(0)) {
            revert ZeroAddress();
        }
        paymentToken = IERC20(_paymentToken);
        payeeRegistry = IERC8004PayeeRegistry(_payeeRegistry);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        _grantRole(ARBITER_ROLE, arbiter);
    }

    // =========================================================================
    // Invoice Issuance
    // =========================================================================

    function createInvoice(CreateInvoiceParams calldata params, SplitRecipient[] calldata splits)
        external
        whenNotPaused
        returns (uint256 invoiceId)
    {
        if (params.amount == 0) revert InvalidAmount();
        if (params.expiresAt <= block.timestamp) revert InvalidExpiry();
        if (params.expectedPayoutWallet == address(0)) revert ZeroAddress();
        if (params.expectedHandleHash == bytes32(0) || params.expectedLegalHash == bytes32(0)) {
            revert InvalidCoPHash();
        }
        if (params.disputeWindow > MAX_DISPUTE_WINDOW) revert InvalidDisputeWindow();
        if (params.mode == SettlementMode.MILESTONE_ESCROW && params.disputeWindow == 0) {
            revert InvalidDisputeWindow();
        }
        if (splits.length == 0 || splits.length > MAX_SPLITS) revert InvalidSplits();

        // Caller must be the ERC-8004 agent owner OR its verified active payout wallet
        address agentOwner = payeeRegistry.ownerOfAgent(params.payeeAgentId);
        address activeWallet = payeeRegistry.getAgentWallet(params.payeeAgentId);
        if (msg.sender != agentOwner && msg.sender != activeWallet) {
            revert UnauthorizedIssuer();
        }

        // Enforce live CoP on primary payee at issuance
        _enforcePrimaryCoP(
            params.payeeAgentId,
            params.expectedHandleHash,
            params.expectedLegalHash,
            params.expectedPayoutWallet,
            params.requireAttestation,
            params.strictNoPendingRotation
        );

        // Validate splits: sum == 10_000, every split leg > 0 bps, every recipient verified on ERC-8004
        uint256 bpsSum = 0;
        for (uint256 i = 0; i < splits.length; i++) {
            SplitRecipient calldata s = splits[i];
            if (s.bps == 0 || s.agentId == 0 || s.expectedWallet == address(0)) {
                revert InvalidSplits();
            }
            if (payeeRegistry.isPayeeRevoked(s.agentId)) {
                revert PayeeRevoked(s.agentId);
            }
            address splitActiveWallet = payeeRegistry.getAgentWallet(s.agentId);
            if (splitActiveWallet == address(0) || splitActiveWallet != s.expectedWallet) {
                revert SplitPayeeCheckFailed(i, s.agentId);
            }
            bpsSum += s.bps;
        }
        if (bpsSum != BPS_DENOMINATOR) revert SplitBpsSumMismatch(bpsSum);

        invoiceId = _nextInvoiceId++;
        Invoice storage inv = _invoices[invoiceId];
        inv.id = invoiceId;
        inv.issuer = msg.sender;
        inv.payeeAgentId = params.payeeAgentId;
        inv.expectedHandleHash = params.expectedHandleHash;
        inv.expectedLegalHash = params.expectedLegalHash;
        inv.expectedPayoutWallet = params.expectedPayoutWallet;
        inv.restrictedBuyer = params.restrictedBuyer;
        inv.amount = params.amount;
        inv.createdAt = uint64(block.timestamp);
        inv.expiresAt = params.expiresAt;
        inv.disputeWindow = params.disputeWindow;
        inv.mode = params.mode;
        inv.status = InvoiceStatus.OPEN;
        inv.requireAttestation = params.requireAttestation;
        inv.strictNoPendingRotation = params.strictNoPendingRotation;
        inv.metadataHash = params.metadataHash;

        for (uint256 i = 0; i < splits.length; i++) {
            _invoiceSplits[invoiceId].push(splits[i]);
        }

        emit InvoiceCreated(
            invoiceId,
            params.payeeAgentId,
            params.expectedPayoutWallet,
            params.amount,
            params.mode,
            params.expiresAt,
            splits.length
        );
    }

    // =========================================================================
    // Mandatory Confirmation-of-Payee Payment & Escrow Funding
    // =========================================================================

    /**
     * @notice Pays or funds an invoice after passing atomic on-chain ERC-8004 CoP verification.
     * @dev    Buyer explicitly supplies expected payee identity fields to prevent UI/MITM substitution.
     */
    function payInvoice(
        uint256 invoiceId,
        bytes32 buyerExpectedHandleHash,
        bytes32 buyerExpectedLegalHash,
        address buyerExpectedWallet
    ) external nonReentrant whenNotPaused returns (bytes32 receiptHash) {
        receiptHash = _executePayment(invoiceId, buyerExpectedHandleHash, buyerExpectedLegalHash, buyerExpectedWallet);
    }

    /**
     * @notice Helper returning the domain-bound `invoiceSalt` signed in `payInvoiceWithCoPProof`
     *         so receipts cannot be replayed across different escrows or invoices.
     */
    function computeBoundInvoiceSalt(uint256 invoiceId, bytes32 userSalt) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), invoiceId, userSalt));
    }

    /**
     * @notice Pays or funds an invoice with an additional EIP-712 signed CoP verification receipt.
     * @dev    Binds `invoiceSalt` to `(address(this), invoiceId, userSalt)` to eliminate cross-escrow
     *         and cross-invoice replay, AND burns each digest in `usedCoPReceipts[digest]`.
     */
    function payInvoiceWithCoPProof(
        uint256 invoiceId,
        bytes32 buyerExpectedHandleHash,
        bytes32 buyerExpectedLegalHash,
        address buyerExpectedWallet,
        address receiptSigner,
        bytes32 userSalt,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant whenNotPaused returns (bytes32 receiptHash) {
        Invoice storage inv = _requireInvoice(invoiceId);
        bytes32 boundSalt = computeBoundInvoiceSalt(invoiceId, userSalt);

        (bool valid, bytes32 digest) = payeeRegistry.verifySignedCoPReceipt(
            inv.payeeAgentId,
            buyerExpectedHandleHash,
            buyerExpectedLegalHash,
            buyerExpectedWallet,
            boundSalt,
            nonce,
            deadline,
            receiptSigner,
            signature
        );
        if (!valid) revert InvalidCoPSignature();
        if (usedCoPReceipts[digest]) revert CoPReceiptAlreadyUsed(digest);

        usedCoPReceipts[digest] = true;
        receiptHash = _executePayment(invoiceId, buyerExpectedHandleHash, buyerExpectedLegalHash, buyerExpectedWallet);
    }

    // =========================================================================
    // Milestone Escrow Release, Disputes & Zero-Stuck-Funds Emergency Exit
    // =========================================================================

    /**
     * @notice Buyer approves delivery and releases escrowed tUSD8 early after re-verifying CoP.
     */
    function releaseEscrow(uint256 invoiceId) external nonReentrant whenNotPaused {
        Invoice storage inv = _requireInvoice(invoiceId);
        if (inv.status != InvoiceStatus.FUNDED) revert InvalidStatus(InvoiceStatus.FUNDED, inv.status);
        if (msg.sender != inv.payer) revert UnauthorizedCaller();

        _settleFundedEscrow(inv);
    }

    /**
     * @notice Releases escrowed tUSD8 after the buyer dispute window expires with no dispute.
     */
    function finalizeEscrow(uint256 invoiceId) external nonReentrant whenNotPaused {
        Invoice storage inv = _requireInvoice(invoiceId);
        if (inv.status != InvoiceStatus.FUNDED) revert InvalidStatus(InvoiceStatus.FUNDED, inv.status);
        if (block.timestamp <= inv.disputeDeadline) revert DisputeWindowActive(inv.disputeDeadline);

        _settleFundedEscrow(inv);
    }

    /**
     * @notice Buyer freezes an active escrow within the dispute window.
     * @dev    Intentionally NOT gated by `whenNotPaused` (moves 0 tokens) so a protocol pause
     *         spanning `disputeDeadline` can never lock buyers out of disputing an escrow.
     */
    function openDispute(uint256 invoiceId, bytes32 reasonHash) external {
        Invoice storage inv = _requireInvoice(invoiceId);
        if (inv.status != InvoiceStatus.FUNDED) revert InvalidStatus(InvoiceStatus.FUNDED, inv.status);
        if (msg.sender != inv.payer) revert UnauthorizedCaller();
        if (block.timestamp > inv.disputeDeadline) revert DisputeWindowClosed(inv.disputeDeadline);

        inv.status = InvoiceStatus.DISPUTED;
        inv.disputeReasonHash = reasonHash;
        emit DisputeOpened(invoiceId, msg.sender, reasonHash);
    }

    /**
     * @notice Arbiter resolves a disputed invoice by splitting escrowed funds between buyer and verified payee splits.
     * @param buyerRefundBps Portion of `inv.amount` refunded to `inv.payer` (0..10000).
     */
    function resolveDispute(uint256 invoiceId, uint16 buyerRefundBps) external nonReentrant onlyRole(ARBITER_ROLE) {
        Invoice storage inv = _requireInvoice(invoiceId);
        if (inv.status != InvoiceStatus.DISPUTED) revert InvalidStatus(InvoiceStatus.DISPUTED, inv.status);
        if (buyerRefundBps > BPS_DENOMINATOR) revert InvalidRefundBps(buyerRefundBps);

        uint256 buyerRefund = (inv.amount * buyerRefundBps) / BPS_DENOMINATOR;
        uint256 payeePortion = inv.amount - buyerRefund;

        if (payeePortion > 0) {
            // Re-verify live CoP + strict rotation lock; KYB expiry post-funding does not trap earned payouts
            _enforcePrimaryCoP(
                inv.payeeAgentId,
                inv.expectedHandleHash,
                inv.expectedLegalHash,
                inv.expectedPayoutWallet,
                false,
                inv.strictNoPendingRotation
            );
            _enforceSplitRecipients(invoiceId);
        }

        // Effects before interactions (CEI)
        inv.status = (payeePortion == 0) ? InvoiceStatus.REFUNDED : InvoiceStatus.SETTLED;
        bytes32 receiptHash = _computeReceiptHash(inv, payeePortion, inv.status);
        inv.receiptHash = receiptHash;

        // Interactions
        if (buyerRefund > 0) {
            paymentToken.safeTransfer(inv.payer, buyerRefund);
        }
        if (payeePortion > 0) {
            _distributeFromSelf(invoiceId, payeePortion);
        }

        emit DisputeResolved(invoiceId, msg.sender, buyerRefund, payeePortion, receiptHash);
    }

    /**
     * @notice Zero-stuck-funds buyer safety valve: if the primary payee OR any split recipient is
     *         revoked, rotates away from the locked wallet, transfers their ERC-8004 NFT, or alters
     *         handle/legal identity post-funding, buyer can immediately reclaim 100% of escrowed tUSD8.
     * @dev    Intentionally callable even while paused AND even after `disputeDeadline`.
     */
    function emergencyRefundInvalidatedPayee(uint256 invoiceId) external nonReentrant {
        _executeEmergencyRefund(invoiceId);
    }

    /**
     * @notice Backwards-compatible alias for `emergencyRefundInvalidatedPayee`.
     */
    function emergencyRefundRevokedPayee(uint256 invoiceId) external nonReentrant {
        _executeEmergencyRefund(invoiceId);
    }

    function cancelInvoice(uint256 invoiceId) external whenNotPaused {
        Invoice storage inv = _requireInvoice(invoiceId);
        if (inv.status != InvoiceStatus.OPEN) revert InvalidStatus(InvoiceStatus.OPEN, inv.status);
        address agentOwner = payeeRegistry.ownerOfAgent(inv.payeeAgentId);
        if (msg.sender != inv.issuer && msg.sender != agentOwner) revert UnauthorizedCaller();

        inv.status = InvoiceStatus.CANCELLED;
        emit InvoiceCancelled(invoiceId, msg.sender);
    }

    function markExpired(uint256 invoiceId) external {
        Invoice storage inv = _requireInvoice(invoiceId);
        if (inv.status != InvoiceStatus.OPEN) revert InvalidStatus(InvoiceStatus.OPEN, inv.status);
        if (block.timestamp <= inv.expiresAt) revert InvoiceNotExpiredYet(inv.expiresAt);

        inv.status = InvoiceStatus.EXPIRED;
        emit InvoiceExpiredEvent(invoiceId);
    }

    // =========================================================================
    // Pre-Flight CoP Read Oracle & Getters
    // =========================================================================

    function preflightCheck(uint256 invoiceId)
        external
        view
        returns (bool payableNow, IERC8004PayeeRegistry.CoPResult memory primaryCoP, string memory reason)
    {
        Invoice storage inv = _invoices[invoiceId];
        if (inv.id == 0) {
            return (false, primaryCoP, "INVOICE_NOT_FOUND");
        }

        primaryCoP = payeeRegistry.verifyPayee(
            inv.payeeAgentId,
            inv.expectedHandleHash,
            inv.expectedLegalHash,
            inv.expectedPayoutWallet
        );

        if (inv.status != InvoiceStatus.OPEN) {
            return (false, primaryCoP, "INVOICE_NOT_OPEN");
        }
        if (block.timestamp > inv.expiresAt) {
            return (false, primaryCoP, "INVOICE_EXPIRED");
        }
        if (primaryCoP.status == IERC8004PayeeRegistry.CoPStatus.PAYEE_REVOKED) {
            return (false, primaryCoP, "PAYEE_REVOKED");
        }
        if (primaryCoP.status == IERC8004PayeeRegistry.CoPStatus.WALLET_ROTATION_PENDING) {
            if (inv.strictNoPendingRotation) {
                return (false, primaryCoP, "WALLET_ROTATION_PENDING");
            }
        } else if (primaryCoP.status != IERC8004PayeeRegistry.CoPStatus.EXACT_MATCH) {
            return (false, primaryCoP, "PAYEE_MISMATCH");
        }
        if (inv.requireAttestation && !primaryCoP.isAttested) {
            return (false, primaryCoP, "PAYEE_UNATTESTED");
        }

        SplitRecipient[] storage splits = _invoiceSplits[invoiceId];
        for (uint256 i = 0; i < splits.length; i++) {
            if (payeeRegistry.isPayeeRevoked(splits[i].agentId)) {
                return (false, primaryCoP, "SPLIT_PAYEE_REVOKED");
            }
            if (payeeRegistry.getAgentWallet(splits[i].agentId) != splits[i].expectedWallet) {
                return (false, primaryCoP, "SPLIT_PAYEE_MISMATCH");
            }
        }

        return (true, primaryCoP, "EXACT_MATCH_READY");
    }

    function getInvoice(uint256 invoiceId) external view returns (Invoice memory) {
        return _requireInvoice(invoiceId);
    }

    function getInvoiceSplits(uint256 invoiceId) external view returns (SplitRecipient[] memory) {
        _requireInvoice(invoiceId);
        return _invoiceSplits[invoiceId];
    }

    function getReceipt(uint256 invoiceId) external view returns (bytes32) {
        return _requireInvoice(invoiceId).receiptHash;
    }

    function invoiceCount() external view returns (uint256) {
        return _nextInvoiceId - 1;
    }

    // =========================================================================
    // Pause Controls
    // =========================================================================

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // =========================================================================
    // Internal CoP Enforcement & Dust-Free Distribution
    // =========================================================================

    function _executePayment(
        uint256 invoiceId,
        bytes32 buyerExpectedHandleHash,
        bytes32 buyerExpectedLegalHash,
        address buyerExpectedWallet
    ) internal returns (bytes32 receiptHash) {
        Invoice storage inv = _requireInvoice(invoiceId);

        if (inv.status == InvoiceStatus.SETTLED || inv.status == InvoiceStatus.FUNDED) {
            revert AlreadySettled(invoiceId);
        }
        if (inv.status != InvoiceStatus.OPEN) {
            revert InvalidStatus(InvoiceStatus.OPEN, inv.status);
        }
        if (block.timestamp > inv.expiresAt) {
            revert InvoiceExpired(invoiceId);
        }
        if (inv.restrictedBuyer != address(0) && msg.sender != inv.restrictedBuyer) {
            revert UnauthorizedBuyer();
        }

        // Cross-check buyer expectations against immutable invoice parameters (prevents substitution attacks)
        if (
            buyerExpectedHandleHash != inv.expectedHandleHash || buyerExpectedLegalHash != inv.expectedLegalHash
                || buyerExpectedWallet != inv.expectedPayoutWallet
        ) {
            revert BuyerExpectationMismatch();
        }

        // Mandatory live ERC-8004 Confirmation-of-Payee gate (primary payee + every split leg)
        _enforcePrimaryCoP(
            inv.payeeAgentId,
            inv.expectedHandleHash,
            inv.expectedLegalHash,
            inv.expectedPayoutWallet,
            inv.requireAttestation,
            inv.strictNoPendingRotation
        );
        _enforceSplitRecipients(invoiceId);

        inv.payer = msg.sender;

        if (inv.mode == SettlementMode.INSTANT) {
            // CEI: update state before external token transfers
            inv.status = InvoiceStatus.SETTLED;
            receiptHash = _computeReceiptHash(inv, inv.amount, InvoiceStatus.SETTLED);
            inv.receiptHash = receiptHash;

            paymentToken.safeTransferFrom(msg.sender, address(this), inv.amount);
            _distributeFromSelf(invoiceId, inv.amount);

            emit InvoiceSettled(invoiceId, msg.sender, inv.payeeAgentId, inv.amount, receiptHash);
        } else {
            // MILESTONE_ESCROW
            uint64 deadline = uint64(block.timestamp) + inv.disputeWindow;
            inv.status = InvoiceStatus.FUNDED;
            inv.disputeDeadline = deadline;
            receiptHash = _computeReceiptHash(inv, inv.amount, InvoiceStatus.FUNDED);
            inv.receiptHash = receiptHash;

            paymentToken.safeTransferFrom(msg.sender, address(this), inv.amount);

            emit InvoiceFunded(invoiceId, msg.sender, inv.payeeAgentId, inv.amount, deadline, receiptHash);
        }
    }

    function _settleFundedEscrow(Invoice storage inv) internal {
        // Re-verify live CoP + strict rotation lock at release time so compromised/rotating payees cannot withdraw.
        // Note: `requireAttestation` is intentionally NOT re-enforced post-funding so routine KYB certificate
        // expiration mid-milestone cannot strand an otherwise valid, unrevoked merchant's earned escrow.
        _enforcePrimaryCoP(
            inv.payeeAgentId,
            inv.expectedHandleHash,
            inv.expectedLegalHash,
            inv.expectedPayoutWallet,
            false,
            inv.strictNoPendingRotation
        );
        _enforceSplitRecipients(inv.id);

        inv.status = InvoiceStatus.SETTLED;
        bytes32 receiptHash = _computeReceiptHash(inv, inv.amount, InvoiceStatus.SETTLED);
        inv.receiptHash = receiptHash;

        _distributeFromSelf(inv.id, inv.amount);
        emit InvoiceSettled(inv.id, inv.payer, inv.payeeAgentId, inv.amount, receiptHash);
    }

    function _executeEmergencyRefund(uint256 invoiceId) internal {
        Invoice storage inv = _requireInvoice(invoiceId);
        if (inv.status != InvoiceStatus.FUNDED && inv.status != InvoiceStatus.DISPUTED) {
            revert InvalidStatus(InvoiceStatus.FUNDED, inv.status);
        }
        if (msg.sender != inv.payer) revert UnauthorizedCaller();

        uint256 invalidatedAgentId = _findInvalidatedAgent(inv);
        if (invalidatedAgentId == 0) revert PayeeStillValid();

        inv.status = InvoiceStatus.REFUNDED;
        inv.receiptHash = _computeReceiptHash(inv, 0, InvoiceStatus.REFUNDED);

        paymentToken.safeTransfer(inv.payer, inv.amount);
        emit EmergencyRefundIssued(invoiceId, inv.payer, inv.amount, invalidatedAgentId);
    }

    function _enforcePrimaryCoP(
        uint256 agentId,
        bytes32 expectedHandleHash,
        bytes32 expectedLegalHash,
        address expectedWallet,
        bool requireAttestation,
        bool strictNoPendingRotation
    ) internal view {
        IERC8004PayeeRegistry.CoPResult memory cop =
            payeeRegistry.verifyPayee(agentId, expectedHandleHash, expectedLegalHash, expectedWallet);

        if (cop.status == IERC8004PayeeRegistry.CoPStatus.PAYEE_REVOKED) {
            revert PayeeRevoked(agentId);
        }
        if (cop.status == IERC8004PayeeRegistry.CoPStatus.WALLET_ROTATION_PENDING) {
            if (strictNoPendingRotation) {
                revert PayeeRotationPending(agentId);
            }
        } else if (cop.status != IERC8004PayeeRegistry.CoPStatus.EXACT_MATCH) {
            revert PayeeMismatch(cop.status);
        }
        if (requireAttestation && !cop.isAttested) {
            revert PayeeUnattested(agentId);
        }
    }

    function _enforceSplitRecipients(uint256 invoiceId) internal view {
        SplitRecipient[] storage splits = _invoiceSplits[invoiceId];
        for (uint256 i = 0; i < splits.length; i++) {
            SplitRecipient storage s = splits[i];
            if (payeeRegistry.isPayeeRevoked(s.agentId)) {
                revert PayeeRevoked(s.agentId);
            }
            address activeWallet = payeeRegistry.getAgentWallet(s.agentId);
            if (activeWallet == address(0) || activeWallet != s.expectedWallet) {
                revert SplitPayeeCheckFailed(i, s.agentId);
            }
        }
    }

    /**
     * @dev Dust-free pro-rata distribution: assigns rounding remainder (`totalAmount - distributed`)
     *      to the final split leg so zero wei is ever stranded in the escrow contract.
     */
    function _distributeFromSelf(uint256 invoiceId, uint256 totalAmount) internal {
        SplitRecipient[] storage splits = _invoiceSplits[invoiceId];
        uint256 len = splits.length;
        uint256 distributed = 0;

        for (uint256 i = 0; i < len; i++) {
            SplitRecipient storage s = splits[i];
            uint256 legAmount = (i == len - 1) ? (totalAmount - distributed) : ((totalAmount * s.bps) / BPS_DENOMINATOR);
            distributed += legAmount;

            if (legAmount > 0) {
                paymentToken.safeTransfer(s.expectedWallet, legAmount);
            }
            emit SplitDistributed(invoiceId, s.agentId, s.expectedWallet, legAmount, s.bps);
        }
    }

    /**
     * @dev Returns a non-zero `agentId` if the primary payee OR any split recipient is permanently
     *      invalidated for this escrow (revoked, rotated away from locked wallet, transferred NFT,
     *      or changed handle/legal profile), ensuring escrowed funds can never become permanently stuck.
     */
    function _findInvalidatedAgent(Invoice storage inv) internal view returns (uint256) {
        IERC8004PayeeRegistry.CoPResult memory primaryCoP = payeeRegistry.verifyPayee(
            inv.payeeAgentId,
            inv.expectedHandleHash,
            inv.expectedLegalHash,
            inv.expectedPayoutWallet
        );
        if (
            primaryCoP.status != IERC8004PayeeRegistry.CoPStatus.EXACT_MATCH
                && primaryCoP.status != IERC8004PayeeRegistry.CoPStatus.WALLET_ROTATION_PENDING
        ) {
            return inv.payeeAgentId;
        }

        SplitRecipient[] storage splits = _invoiceSplits[inv.id];
        for (uint256 i = 0; i < splits.length; i++) {
            SplitRecipient storage s = splits[i];
            if (payeeRegistry.isPayeeRevoked(s.agentId)) {
                return s.agentId;
            }
            address activeWallet = payeeRegistry.getAgentWallet(s.agentId);
            if (activeWallet == address(0) || activeWallet != s.expectedWallet) {
                return s.agentId;
            }
        }
        return 0;
    }

    function _computeReceiptHash(Invoice storage inv, uint256 settledAmount, InvoiceStatus finalStatus)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                block.chainid,
                address(this),
                inv.id,
                inv.payer,
                inv.payeeAgentId,
                inv.expectedHandleHash,
                inv.expectedLegalHash,
                inv.expectedPayoutWallet,
                settledAmount,
                finalStatus,
                block.timestamp
            )
        );
    }

    function _requireInvoice(uint256 invoiceId) internal view returns (Invoice storage inv) {
        inv = _invoices[invoiceId];
        if (inv.id == 0) revert InvoiceNotFound(invoiceId);
    }
}
