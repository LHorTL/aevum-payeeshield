// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * @title IERC8004PayeeRegistry
 * @notice ERC-8004 Trustless Agents Identity Registry interface extended with
 *         Confirmation-of-Payee (CoP) verification, timelocked payout wallet
 *         rotation, revocation, profile-epoch KYB attestations, and EIP-712
 *         signed verification receipts.
 */
interface IERC8004PayeeRegistry {
    /// @notice Structured key-value metadata entry per ERC-8004 Identity Registry.
    struct MetadataEntry {
        string metadataKey;
        bytes metadataValue;
    }

    /// @notice Confirmation-of-Payee evaluation codes modeled after UK CoP / EU VoP.
    enum CoPStatus {
        UNREGISTERED,
        EXACT_MATCH,
        CLOSE_MATCH_WARNING,
        NO_MATCH,
        PAYEE_REVOKED,
        WALLET_ROTATION_PENDING
    }

    /// @notice Full payee profile anchored to an ERC-8004 agent NFT.
    struct PayeeProfile {
        uint256 agentId;
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
        uint32 activeAttestations;
    }

    /// @notice Deterministic Confirmation-of-Payee result returned for pre-flight and settlement checks.
    struct CoPResult {
        CoPStatus status;
        uint256 resolvedAgentId;
        address activePayoutWallet;
        bytes32 activeHandleHash;
        bytes32 activeLegalHash;
        bool hasPendingRotation;
        bool isAttested;
    }

    /// @notice Verifiable third-party KYB / compliance attestation record bound to a `profileEpoch`.
    struct Attestation {
        bytes32 attestationId;
        address attester;
        bytes32 schemaId;
        bytes32 evidenceHash;
        uint64 issuedAt;
        uint64 expiresAt;
        uint64 profileEpoch;
        bool revoked;
    }

    // ---- Standard ERC-8004 Identity Registry Events ----
    event AgentRegistered(uint256 indexed agentId, address indexed owner, string agentURI);
    event AgentURIUpdated(uint256 indexed agentId, string newURI);
    event MetadataUpdated(uint256 indexed agentId, string indexed indexedKey, string metadataKey, bytes metadataValue);
    event AgentWalletUpdated(uint256 indexed agentId, address indexed previousWallet, address indexed newWallet);

    // ---- Confirmation-of-Payee Extension Events ----
    event PayeeProfileBound(
        uint256 indexed agentId,
        bytes32 indexed handleHash,
        string handle,
        bytes32 legalEntityHash,
        address indexed payoutWallet,
        uint64 profileEpoch
    );
    event PayoutWalletRotationProposed(
        uint256 indexed agentId,
        address indexed currentWallet,
        address indexed pendingWallet,
        uint64 executableAt
    );
    event PayoutWalletRotationCancelled(uint256 indexed agentId, address indexed cancelledPendingWallet, address indexed cancelledBy);
    event PayeeRevokedEvent(uint256 indexed agentId, address indexed revokedBy, bytes32 reasonHash);
    event AttestationIssued(
        uint256 indexed agentId,
        bytes32 indexed attestationId,
        address indexed attester,
        bytes32 schemaId,
        bytes32 evidenceHash,
        uint64 expiresAt,
        uint64 profileEpoch
    );
    event AttestationRevoked(uint256 indexed agentId, bytes32 indexed attestationId, address indexed revokedBy);

    // ---- Standard ERC-8004 Functions ----
    function register(string calldata agentURI) external returns (uint256 agentId);
    function register(string calldata agentURI, MetadataEntry[] calldata metadata) external returns (uint256 agentId);
    function setAgentURI(uint256 agentId, string calldata newURI) external;
    function getMetadata(uint256 agentId, string calldata metadataKey) external view returns (bytes memory);
    function setMetadata(uint256 agentId, string calldata metadataKey, bytes calldata metadataValue) external;
    function getAgentWallet(uint256 agentId) external view returns (address);
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature) external;

    // ---- Confirmation-of-Payee & Commercial Payee Functions ----
    function registerPayee(
        string calldata handle,
        bytes32 legalEntityHash,
        string calldata agentURI,
        MetadataEntry[] calldata metadata
    ) external returns (uint256 agentId);

    function finalizePayoutWalletRotation(uint256 agentId) external;
    function cancelPayoutWalletRotation(uint256 agentId) external;
    function revokePayee(uint256 agentId, bytes32 reasonHash) external;

    function verifyPayee(
        uint256 agentId,
        bytes32 expectedHandleHash,
        bytes32 expectedLegalHash,
        address expectedWallet
    ) external view returns (CoPResult memory);

    function verifyPayeeByHandle(
        string calldata handle,
        bytes32 expectedLegalHash,
        address expectedWallet
    ) external view returns (CoPResult memory);

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
    ) external view returns (bool valid, bytes32 digest);

    function getPayeeProfile(uint256 agentId) external view returns (PayeeProfile memory);
    function agentIdByHandleHash(bytes32 handleHash) external view returns (uint256);
    function isPayeeActive(uint256 agentId) external view returns (bool);
    function isPayeeRevoked(uint256 agentId) external view returns (bool);
    function hasValidAttestation(uint256 agentId) external view returns (bool);
    function isAuthorizedAttester(address account) external view returns (bool);
    function ownerOfAgent(uint256 agentId) external view returns (address);
}
