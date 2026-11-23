// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC8004PayeeRegistry} from "./interfaces/IERC8004PayeeRegistry.sol";

/**
 * @title ERC8004PayeeRegistry
 * @notice Full ERC-8004 ("Trustless Agents") Identity Registry with built-in
 *         Confirmation-of-Payee (CoP) verification, ASCII homoglyph-resistant handle
 *         normalization, timelocked payout wallet rotation, emergency revocation,
 *         epoch-bound KYB/compliance attestations, and EIP-712 signed verification receipts.
 * @dev    Designed for QDay Aevum Testnet (Chain ID 44005, Shanghai EVM target).
 *         Enforces strict CEI + ReentrancyGuard around `_safeMint`, automatic `agentWallet`
 *         reset + `profileEpoch` & `walletNonces` invalidation on NFT transfer or profile change,
 *         and bounded attestation storage (`MAX_ATTESTATIONS_PER_AGENT = 64`).
 */
contract ERC8004PayeeRegistry is
    ERC721URIStorage,
    EIP712,
    AccessControl,
    Pausable,
    ReentrancyGuard,
    IERC8004PayeeRegistry
{
    bytes32 public constant ATTESTER_ROLE = keccak256("ATTESTER_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    bytes32 public constant RESERVED_AGENT_WALLET_KEY = keccak256("agentWallet");

    /// @notice EIP-712 typehash proving the destination wallet consents to binding to `agentId`.
    bytes32 public constant SET_AGENT_WALLET_TYPEHASH = keccak256(
        "SetAgentWallet(uint256 agentId,address newWallet,uint256 nonce,uint256 deadline)"
    );

    /// @notice EIP-712 typehash for signed Confirmation-of-Payee receipts.
    bytes32 public constant COP_RECEIPT_TYPEHASH = keccak256(
        "CoPReceipt(uint256 agentId,bytes32 handleHash,bytes32 legalEntityHash,address payoutWallet,bytes32 invoiceSalt,uint256 nonce,uint256 deadline)"
    );

    uint64 public constant MAX_ROTATION_COOLDOWN = 7 days;
    uint256 public constant MAX_ATTESTATIONS_PER_AGENT = 64;

    uint256 private _nextAgentId = 1;
    uint64 public rotationCooldown;

    struct InternalProfile {
        string handle;
        bytes32 handleHash;
        bytes32 legalEntityHash;
        address payoutWallet;
        address pendingPayoutWallet;
        uint64 rotationExecutableAt;
        uint64 registeredAt;
        uint64 updatedAt;
        uint64 profileEpoch;
        bool revoked;
        bytes32 revocationReasonHash;
    }

    mapping(uint256 => InternalProfile) private _profiles;
    mapping(bytes32 => uint256) private _handleHashToAgentId;
    mapping(uint256 => mapping(bytes32 => bytes)) private _metadata;
    mapping(uint256 => uint256) public walletNonces;

    mapping(uint256 => bytes32[]) private _agentAttestationIds;
    mapping(uint256 => mapping(bytes32 => Attestation)) private _attestations;

    // ---- Custom Errors ----
    error ZeroAddress();
    error InvalidHandle();
    error HandleAlreadyRegistered(bytes32 handleHash);
    error InvalidLegalEntityHash();
    error ReservedMetadataKey();
    error AgentNotFound(uint256 agentId);
    error NotAgentController(uint256 agentId, address caller);
    error PayeeAlreadyRevoked(uint256 agentId);
    error SignatureExpired(uint256 deadline);
    error InvalidWalletSignature();
    error SamePayoutWallet();
    error NoPendingRotation(uint256 agentId);
    error RotationCooldownActive(uint64 executableAt);
    error CooldownTooLong(uint64 provided);
    error InvalidAttestationExpiry();
    error MaxAttestationsReached(uint256 agentId);
    error AttestationNotFound(bytes32 attestationId);
    error AttestationAlreadyRevoked(bytes32 attestationId);

    constructor(address admin, uint64 initialRotationCooldown)
        ERC721("PayeeShield ERC-8004 Identity", "PS8004")
        EIP712("PayeeShieldERC8004Registry", "1")
    {
        if (admin == address(0)) revert ZeroAddress();
        if (initialRotationCooldown > MAX_ROTATION_COOLDOWN) revert CooldownTooLong(initialRotationCooldown);

        rotationCooldown = initialRotationCooldown;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ATTESTER_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, admin);
    }

    // =========================================================================
    // Standard ERC-8004 Identity Registry Interface (Strict CEI + nonReentrant)
    // =========================================================================

    /// @inheritdoc IERC8004PayeeRegistry
    function register(string calldata agentURI) external whenNotPaused nonReentrant returns (uint256 agentId) {
        agentId = _allocateAndWriteProfile(msg.sender, "", bytes32(0), bytes32(0));
        _finalizeMintAndURI(msg.sender, agentId, agentURI);
    }

    /// @inheritdoc IERC8004PayeeRegistry
    function register(string calldata agentURI, MetadataEntry[] calldata metadata)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 agentId)
    {
        agentId = _allocateAndWriteProfile(msg.sender, "", bytes32(0), bytes32(0));
        _writeMetadataBatch(agentId, metadata);
        _finalizeMintAndURI(msg.sender, agentId, agentURI);
    }

    /// @inheritdoc IERC8004PayeeRegistry
    function registerPayee(
        string calldata handle,
        bytes32 legalEntityHash,
        string calldata agentURI,
        MetadataEntry[] calldata metadata
    ) external whenNotPaused nonReentrant returns (uint256 agentId) {
        if (legalEntityHash == bytes32(0)) revert InvalidLegalEntityHash();
        (string memory normalized, bytes32 handleHash) = normalizeHandle(handle);
        if (_handleHashToAgentId[handleHash] != 0) revert HandleAlreadyRegistered(handleHash);

        // CEI: write ALL profile, handle uniqueness, and metadata state BEFORE `_safeMint` callback
        agentId = _allocateAndWriteProfile(msg.sender, normalized, handleHash, legalEntityHash);
        _handleHashToAgentId[handleHash] = agentId;
        _writeMetadataBatch(agentId, metadata);

        emit PayeeProfileBound(agentId, handleHash, normalized, legalEntityHash, msg.sender, 1);

        _finalizeMintAndURI(msg.sender, agentId, agentURI);
    }

    /**
     * @notice Binds or updates a merchant handle and legal entity hash on an ERC-8004 agentId.
     * @dev    If the identity already had a bound handle or legal entity hash, bumps `profileEpoch`
     *         so all prior KYB attestations issued under the old entity identity are invalidated.
     */
    function bindPayeeProfile(uint256 agentId, string calldata handle, bytes32 legalEntityHash) external whenNotPaused {
        _requireActiveController(agentId);
        if (legalEntityHash == bytes32(0)) revert InvalidLegalEntityHash();

        InternalProfile storage p = _profiles[agentId];
        (string memory normalized, bytes32 handleHash) = normalizeHandle(handle);

        uint256 existing = _handleHashToAgentId[handleHash];
        if (existing != 0 && existing != agentId) revert HandleAlreadyRegistered(handleHash);

        bool wasBound = (p.handleHash != bytes32(0) || p.legalEntityHash != bytes32(0));
        bool identityChanged = (p.handleHash != handleHash || p.legalEntityHash != legalEntityHash);

        if (p.handleHash != bytes32(0) && p.handleHash != handleHash) {
            delete _handleHashToAgentId[p.handleHash];
        }

        if (wasBound && identityChanged) {
            p.profileEpoch += 1;
        }

        p.handle = normalized;
        p.handleHash = handleHash;
        p.legalEntityHash = legalEntityHash;
        p.updatedAt = uint64(block.timestamp);
        _handleHashToAgentId[handleHash] = agentId;

        emit PayeeProfileBound(agentId, handleHash, normalized, legalEntityHash, p.payoutWallet, p.profileEpoch);
    }

    /// @inheritdoc IERC8004PayeeRegistry
    function setAgentURI(uint256 agentId, string calldata newURI) external whenNotPaused {
        _requireActiveController(agentId);
        _setTokenURI(agentId, newURI);
        _profiles[agentId].updatedAt = uint64(block.timestamp);
        emit AgentURIUpdated(agentId, newURI);
    }

    /// @inheritdoc IERC8004PayeeRegistry
    function getMetadata(uint256 agentId, string calldata metadataKey) external view returns (bytes memory) {
        _requireExists(agentId);
        bytes32 keyHash = keccak256(bytes(metadataKey));
        if (keyHash == RESERVED_AGENT_WALLET_KEY) {
            return abi.encode(getAgentWallet(agentId));
        }
        return _metadata[agentId][keyHash];
    }

    /// @inheritdoc IERC8004PayeeRegistry
    function setMetadata(uint256 agentId, string calldata metadataKey, bytes calldata metadataValue)
        external
        whenNotPaused
    {
        _requireActiveController(agentId);
        bytes32 keyHash = keccak256(bytes(metadataKey));
        if (keyHash == RESERVED_AGENT_WALLET_KEY) revert ReservedMetadataKey();

        _metadata[agentId][keyHash] = metadataValue;
        _profiles[agentId].updatedAt = uint64(block.timestamp);
        emit MetadataUpdated(agentId, metadataKey, metadataKey, metadataValue);
    }

    /// @inheritdoc IERC8004PayeeRegistry
    function getAgentWallet(uint256 agentId) public view returns (address) {
        if (_ownerOf(agentId) == address(0)) return address(0);
        InternalProfile storage p = _profiles[agentId];
        if (p.revoked) return address(0);
        return p.payoutWallet;
    }

    /**
     * @inheritdoc IERC8004PayeeRegistry
     * @dev Requires an EIP-712 / ERC-1271 signature from `newWallet` proving wallet control.
     *      If an active payout wallet already exists and `rotationCooldown > 0`, schedules a
     *      timelocked rotation rather than instant swap to defend against hijacked invoices.
     *      If `payoutWallet == address(0)` (e.g. immediately after an ERC-721 identity transfer),
     *      activates immediately once cryptographic wallet control is proven.
     */
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature)
        external
        whenNotPaused
    {
        _requireActiveController(agentId);
        if (newWallet == address(0)) revert ZeroAddress();
        if (block.timestamp > deadline) revert SignatureExpired(deadline);

        InternalProfile storage p = _profiles[agentId];
        if (newWallet == p.payoutWallet) revert SamePayoutWallet();

        uint256 nonce = walletNonces[agentId];
        bytes32 structHash = keccak256(abi.encode(SET_AGENT_WALLET_TYPEHASH, agentId, newWallet, nonce, deadline));
        bytes32 digest = _hashTypedDataV4(structHash);

        if (!_isValidSignature(newWallet, digest, signature)) {
            revert InvalidWalletSignature();
        }
        walletNonces[agentId] = nonce + 1;

        if (p.payoutWallet == address(0) || rotationCooldown == 0) {
            address prev = p.payoutWallet;
            p.payoutWallet = newWallet;
            p.pendingPayoutWallet = address(0);
            p.rotationExecutableAt = 0;
            p.updatedAt = uint64(block.timestamp);
            emit AgentWalletUpdated(agentId, prev, newWallet);
        } else {
            uint64 executableAt = uint64(block.timestamp) + rotationCooldown;
            p.pendingPayoutWallet = newWallet;
            p.rotationExecutableAt = executableAt;
            p.updatedAt = uint64(block.timestamp);
            emit PayoutWalletRotationProposed(agentId, p.payoutWallet, newWallet, executableAt);
        }
    }

    /// @inheritdoc IERC8004PayeeRegistry
    function finalizePayoutWalletRotation(uint256 agentId) external whenNotPaused {
        _requireActiveController(agentId);
        InternalProfile storage p = _profiles[agentId];
        address pending = p.pendingPayoutWallet;
        if (pending == address(0)) revert NoPendingRotation(agentId);
        if (block.timestamp < p.rotationExecutableAt) revert RotationCooldownActive(p.rotationExecutableAt);

        address prev = p.payoutWallet;
        p.payoutWallet = pending;
        p.pendingPayoutWallet = address(0);
        p.rotationExecutableAt = 0;
        p.updatedAt = uint64(block.timestamp);

        emit AgentWalletUpdated(agentId, prev, pending);
    }

    /// @inheritdoc IERC8004PayeeRegistry
    function cancelPayoutWalletRotation(uint256 agentId) external {
        _requireExists(agentId);
        if (!_isController(agentId, msg.sender) && !hasRole(GUARDIAN_ROLE, msg.sender)) {
            revert NotAgentController(agentId, msg.sender);
        }
        InternalProfile storage p = _profiles[agentId];
        address pending = p.pendingPayoutWallet;
        if (pending == address(0)) revert NoPendingRotation(agentId);

        p.pendingPayoutWallet = address(0);
        p.rotationExecutableAt = 0;
        p.updatedAt = uint64(block.timestamp);

        emit PayoutWalletRotationCancelled(agentId, pending, msg.sender);
    }

    // =========================================================================
    // Revocation & Epoch-Bound KYB / Compliance Attestations
    // =========================================================================

    /// @inheritdoc IERC8004PayeeRegistry
    function revokePayee(uint256 agentId, bytes32 reasonHash) external {
        _requireExists(agentId);
        if (!_isController(agentId, msg.sender) && !hasRole(GUARDIAN_ROLE, msg.sender)) {
            revert NotAgentController(agentId, msg.sender);
        }
        InternalProfile storage p = _profiles[agentId];
        if (p.revoked) revert PayeeAlreadyRevoked(agentId);

        address prevWallet = p.payoutWallet;
        p.revoked = true;
        p.revocationReasonHash = reasonHash;
        p.payoutWallet = address(0);
        p.pendingPayoutWallet = address(0);
        p.rotationExecutableAt = 0;
        p.profileEpoch += 1;
        p.updatedAt = uint64(block.timestamp);

        emit PayeeRevokedEvent(agentId, msg.sender, reasonHash);
        if (prevWallet != address(0)) {
            emit AgentWalletUpdated(agentId, prevWallet, address(0));
        }
    }

    /**
     * @notice Issues a verifiable KYB / merchant compliance attestation bound to the agent's current `profileEpoch`.
     */
    function issueAttestation(uint256 agentId, bytes32 schemaId, bytes32 evidenceHash, uint64 expiresAt)
        external
        whenNotPaused
        onlyRole(ATTESTER_ROLE)
        returns (bytes32 attestationId)
    {
        _requireExists(agentId);
        InternalProfile storage p = _profiles[agentId];
        if (p.revoked) revert PayeeAlreadyRevoked(agentId);
        if (expiresAt != 0 && expiresAt <= block.timestamp) revert InvalidAttestationExpiry();
        if (_agentAttestationIds[agentId].length >= MAX_ATTESTATIONS_PER_AGENT) {
            revert MaxAttestationsReached(agentId);
        }

        uint64 epoch = p.profileEpoch;
        attestationId = keccak256(
            abi.encodePacked(agentId, msg.sender, schemaId, evidenceHash, epoch, block.timestamp, _agentAttestationIds[agentId].length)
        );
        _attestations[agentId][attestationId] = Attestation({
            attestationId: attestationId,
            attester: msg.sender,
            schemaId: schemaId,
            evidenceHash: evidenceHash,
            issuedAt: uint64(block.timestamp),
            expiresAt: expiresAt,
            profileEpoch: epoch,
            revoked: false
        });
        _agentAttestationIds[agentId].push(attestationId);

        emit AttestationIssued(agentId, attestationId, msg.sender, schemaId, evidenceHash, expiresAt, epoch);
    }

    /**
     * @notice Revokes a previously issued attestation.
     */
    function revokeAttestation(uint256 agentId, bytes32 attestationId) external {
        if (!hasRole(ATTESTER_ROLE, msg.sender) && !hasRole(GUARDIAN_ROLE, msg.sender)) {
            revert NotAgentController(agentId, msg.sender);
        }
        Attestation storage att = _attestations[agentId][attestationId];
        if (att.issuedAt == 0) revert AttestationNotFound(attestationId);
        if (att.revoked) revert AttestationAlreadyRevoked(attestationId);

        att.revoked = true;
        emit AttestationRevoked(agentId, attestationId, msg.sender);
    }

    function getAttestations(uint256 agentId) external view returns (Attestation[] memory list) {
        bytes32[] storage ids = _agentAttestationIds[agentId];
        list = new Attestation[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            list[i] = _attestations[agentId][ids[i]];
        }
    }

    /// @inheritdoc IERC8004PayeeRegistry
    function hasValidAttestation(uint256 agentId) public view returns (bool) {
        return _hasActiveAttestation(agentId);
    }

    // =========================================================================
    // Confirmation-of-Payee (CoP) On-Chain Verification & EIP-712 Receipts
    // =========================================================================

    /// @inheritdoc IERC8004PayeeRegistry
    function verifyPayee(
        uint256 agentId,
        bytes32 expectedHandleHash,
        bytes32 expectedLegalHash,
        address expectedWallet
    ) public view returns (CoPResult memory result) {
        if (_ownerOf(agentId) == address(0)) {
            result.status = CoPStatus.UNREGISTERED;
            return result;
        }

        InternalProfile storage p = _profiles[agentId];
        bool pendingRot = p.pendingPayoutWallet != address(0);
        bool attested = _hasActiveAttestation(agentId);

        result.resolvedAgentId = agentId;
        result.activePayoutWallet = p.revoked ? address(0) : p.payoutWallet;
        result.activeHandleHash = p.handleHash;
        result.activeLegalHash = p.legalEntityHash;
        result.hasPendingRotation = pendingRot;
        result.isAttested = attested;

        if (p.revoked) {
            result.status = CoPStatus.PAYEE_REVOKED;
            return result;
        }

        if (p.payoutWallet == address(0) || expectedWallet == address(0) || p.payoutWallet != expectedWallet) {
            result.status = CoPStatus.NO_MATCH;
            return result;
        }

        if (expectedHandleHash != bytes32(0) && p.handleHash != expectedHandleHash) {
            result.status = CoPStatus.NO_MATCH;
            return result;
        }

        if (expectedLegalHash != bytes32(0) && p.legalEntityHash != expectedLegalHash) {
            result.status = CoPStatus.CLOSE_MATCH_WARNING;
            return result;
        }

        if (pendingRot) {
            result.status = CoPStatus.WALLET_ROTATION_PENDING;
            return result;
        }

        result.status = CoPStatus.EXACT_MATCH;
    }

    /// @inheritdoc IERC8004PayeeRegistry
    function verifyPayeeByHandle(string calldata handle, bytes32 expectedLegalHash, address expectedWallet)
        external
        view
        returns (CoPResult memory)
    {
        (, bytes32 handleHash) = normalizeHandle(handle);
        uint256 agentId = _handleHashToAgentId[handleHash];
        if (agentId == 0) {
            return CoPResult({
                status: CoPStatus.UNREGISTERED,
                resolvedAgentId: 0,
                activePayoutWallet: address(0),
                activeHandleHash: bytes32(0),
                activeLegalHash: bytes32(0),
                hasPendingRotation: false,
                isAttested: false
            });
        }
        return verifyPayee(agentId, handleHash, expectedLegalHash, expectedWallet);
    }

    /**
     * @inheritdoc IERC8004PayeeRegistry
     * @dev Enforces live payee activity, non-revocation, handle/legal/wallet match, AND
     *      valid EIP-712 / ERC-1271 signature from an authorized attester or active payout wallet.
     */
    function verifySignedCoPReceipt(
        uint256 agentId,
        bytes32 handleHash,
        bytes32 legalEntityHash,
        address payoutWallet,
        bytes32 invoiceSalt,
        uint256 nonce,
        uint256 deadline,
        address expectedSigner,
        bytes calldata signature
    ) external view returns (bool valid, bytes32 digest) {
        if (expectedSigner == address(0) || payoutWallet == address(0) || block.timestamp > deadline) {
            return (false, bytes32(0));
        }

        // Enforce live payee registry state (safe for standalone integrators too!)
        if (_ownerOf(agentId) == address(0)) {
            return (false, bytes32(0));
        }
        InternalProfile storage p = _profiles[agentId];
        if (p.revoked || p.payoutWallet == address(0) || p.payoutWallet != payoutWallet) {
            return (false, bytes32(0));
        }
        if (handleHash != bytes32(0) && p.handleHash != handleHash) {
            return (false, bytes32(0));
        }
        if (legalEntityHash != bytes32(0) && p.legalEntityHash != legalEntityHash) {
            return (false, bytes32(0));
        }

        // Signer must be an authorized KYB attester OR the active verified payout wallet itself.
        bool signerAllowed = hasRole(ATTESTER_ROLE, expectedSigner) || expectedSigner == p.payoutWallet;
        if (!signerAllowed) {
            return (false, bytes32(0));
        }

        bytes32 structHash = keccak256(
            abi.encode(
                COP_RECEIPT_TYPEHASH,
                agentId,
                handleHash,
                legalEntityHash,
                payoutWallet,
                invoiceSalt,
                nonce,
                deadline
            )
        );
        digest = _hashTypedDataV4(structHash);
        valid = _isValidSignature(expectedSigner, digest, signature);
    }

    // =========================================================================
    // Handle Normalization (Strict ASCII Homoglyph Defense)
    // =========================================================================

    /**
     * @notice Normalizes a merchant/agent handle to strict lowercase ASCII (`[a-z0-9._-]`, 3..64 chars).
     * @dev    Rejects all non-ASCII Unicode bytes (Cyrillic, Greek, fullwidth lookalikes),
     *         leading/trailing dots/hyphens, and consecutive dots to prevent visual spoofing.
     */
    function normalizeHandle(string memory rawHandle)
        public
        pure
        returns (string memory normalized, bytes32 handleHash)
    {
        bytes memory src = bytes(rawHandle);
        uint256 len = src.length;
        if (len < 3 || len > 64) revert InvalidHandle();

        bytes memory out = new bytes(len);
        bytes1 prev = 0;

        for (uint256 i = 0; i < len; i++) {
            bytes1 b = src[i];
            if (b >= 0x41 && b <= 0x5A) {
                b = bytes1(uint8(b) + 32);
            }

            bool isAlphaNum = (b >= 0x61 && b <= 0x7A) || (b >= 0x30 && b <= 0x39);
            bool isPunct = (b == 0x2E || b == 0x2D || b == 0x5F); // '.', '-', '_'

            if (!isAlphaNum && !isPunct) revert InvalidHandle();
            if ((i == 0 || i == len - 1) && isPunct) revert InvalidHandle();
            if (b == 0x2E && prev == 0x2E) revert InvalidHandle(); // no '..'

            out[i] = b;
            prev = b;
        }

        normalized = string(out);
        handleHash = keccak256(out);
    }

    // =========================================================================
    // Admin & View Helpers
    // =========================================================================

    function setRotationCooldown(uint64 newCooldown) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newCooldown > MAX_ROTATION_COOLDOWN) revert CooldownTooLong(newCooldown);
        rotationCooldown = newCooldown;
    }

    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /// @inheritdoc IERC8004PayeeRegistry
    function getPayeeProfile(uint256 agentId) external view returns (PayeeProfile memory) {
        _requireExists(agentId);
        InternalProfile storage p = _profiles[agentId];
        return PayeeProfile({
            agentId: agentId,
            handle: p.handle,
            handleHash: p.handleHash,
            legalEntityHash: p.legalEntityHash,
            payoutWallet: p.revoked ? address(0) : p.payoutWallet,
            pendingPayoutWallet: p.pendingPayoutWallet,
            rotationExecutableAt: p.rotationExecutableAt,
            registeredAt: p.registeredAt,
            updatedAt: p.updatedAt,
            profileEpoch: p.profileEpoch,
            revoked: p.revoked,
            activeAttestations: _countActiveAttestations(agentId)
        });
    }

    /// @inheritdoc IERC8004PayeeRegistry
    function agentIdByHandleHash(bytes32 handleHash) external view returns (uint256) {
        return _handleHashToAgentId[handleHash];
    }

    /// @inheritdoc IERC8004PayeeRegistry
    function isPayeeActive(uint256 agentId) external view returns (bool) {
        return _ownerOf(agentId) != address(0) && !_profiles[agentId].revoked && _profiles[agentId].payoutWallet != address(0);
    }

    /// @inheritdoc IERC8004PayeeRegistry
    function isPayeeRevoked(uint256 agentId) external view returns (bool) {
        if (_ownerOf(agentId) == address(0)) return false;
        return _profiles[agentId].revoked;
    }

    /// @inheritdoc IERC8004PayeeRegistry
    function isAuthorizedAttester(address account) external view returns (bool) {
        return hasRole(ATTESTER_ROLE, account);
    }

    /// @inheritdoc IERC8004PayeeRegistry
    function ownerOfAgent(uint256 agentId) external view returns (address) {
        return ownerOf(agentId);
    }

    function totalAgents() external view returns (uint256) {
        return _nextAgentId - 1;
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721URIStorage, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    // =========================================================================
    // Internal ERC-721 Transfer-Safety Hook & Helpers
    // =========================================================================

    function _allocateAndWriteProfile(
        address owner,
        string memory normalizedHandle,
        bytes32 handleHash,
        bytes32 legalEntityHash
    ) internal returns (uint256 agentId) {
        agentId = _nextAgentId++;
        InternalProfile storage p = _profiles[agentId];
        p.handle = normalizedHandle;
        p.handleHash = handleHash;
        p.legalEntityHash = legalEntityHash;
        p.payoutWallet = owner;
        p.registeredAt = uint64(block.timestamp);
        p.updatedAt = uint64(block.timestamp);
        p.profileEpoch = 1;
    }

    function _finalizeMintAndURI(address owner, uint256 agentId, string calldata agentURI) internal {
        if (bytes(agentURI).length > 0) {
            _setTokenURI(agentId, agentURI);
        }
        emit AgentRegistered(agentId, owner, agentURI);
        emit AgentWalletUpdated(agentId, address(0), owner);

        // External `onERC721Received` interaction happens strictly LAST (CEI)
        _safeMint(owner, agentId);
    }

    function _writeMetadataBatch(uint256 agentId, MetadataEntry[] calldata metadata) internal {
        for (uint256 i = 0; i < metadata.length; i++) {
            bytes32 keyHash = keccak256(bytes(metadata[i].metadataKey));
            if (keyHash == RESERVED_AGENT_WALLET_KEY) revert ReservedMetadataKey();
            _metadata[agentId][keyHash] = metadata[i].metadataValue;
            emit MetadataUpdated(agentId, metadata[i].metadataKey, metadata[i].metadataKey, metadata[i].metadataValue);
        }
    }

    /**
     * @dev ERC-8004 Transfer Safety: transferring an agent identity NFT automatically clears
     *      its active `payoutWallet` and any pending rotation, invalidates prior KYB attestations
     *      via `profileEpoch++`, and invalidates pre-transfer `setAgentWallet` signatures via
     *      `walletNonces[tokenId]++`.
     */
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = super._update(to, tokenId, auth);
        if (from != address(0) && to != address(0) && from != to) {
            InternalProfile storage p = _profiles[tokenId];
            address prevWallet = p.payoutWallet;
            p.payoutWallet = address(0);
            p.pendingPayoutWallet = address(0);
            p.rotationExecutableAt = 0;
            p.profileEpoch += 1;
            p.updatedAt = uint64(block.timestamp);
            walletNonces[tokenId] += 1;
            if (prevWallet != address(0)) {
                emit AgentWalletUpdated(tokenId, prevWallet, address(0));
            }
        }
    }

    function _hasActiveAttestation(uint256 agentId) internal view returns (bool) {
        InternalProfile storage p = _profiles[agentId];
        if (p.revoked) return false;
        uint64 currentEpoch = p.profileEpoch;
        bytes32[] storage ids = _agentAttestationIds[agentId];
        for (uint256 i = 0; i < ids.length; i++) {
            Attestation storage att = _attestations[agentId][ids[i]];
            if (
                !att.revoked && att.profileEpoch == currentEpoch
                    && (att.expiresAt == 0 || att.expiresAt > block.timestamp)
            ) {
                return true;
            }
        }
        return false;
    }

    function _countActiveAttestations(uint256 agentId) internal view returns (uint32 count) {
        InternalProfile storage p = _profiles[agentId];
        if (p.revoked) return 0;
        uint64 currentEpoch = p.profileEpoch;
        bytes32[] storage ids = _agentAttestationIds[agentId];
        for (uint256 i = 0; i < ids.length; i++) {
            Attestation storage att = _attestations[agentId][ids[i]];
            if (
                !att.revoked && att.profileEpoch == currentEpoch
                    && (att.expiresAt == 0 || att.expiresAt > block.timestamp)
            ) {
                count++;
            }
        }
    }

    function _requireExists(uint256 agentId) internal view {
        if (_ownerOf(agentId) == address(0)) revert AgentNotFound(agentId);
    }

    function _isController(uint256 agentId, address account) internal view returns (bool) {
        address owner = _ownerOf(agentId);
        return owner == account || getApproved(agentId) == account || isApprovedForAll(owner, account);
    }

    function _isValidSignature(address signer, bytes32 digest, bytes calldata signature) internal view returns (bool) {
        if (signer.code.length == 0) {
            (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
            return err == ECDSA.RecoverError.NoError && recovered == signer;
        }
        try IERC1271(signer).isValidSignature(digest, signature) returns (bytes4 magicValue) {
            return magicValue == IERC1271.isValidSignature.selector;
        } catch {
            return false;
        }
    }

    function _requireActiveController(uint256 agentId) internal view {
        _requireExists(agentId);
        if (!_isController(agentId, msg.sender)) revert NotAgentController(agentId, msg.sender);
        if (_profiles[agentId].revoked) revert PayeeAlreadyRevoked(agentId);
    }
}
