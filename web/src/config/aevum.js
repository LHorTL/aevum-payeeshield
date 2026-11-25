export const AEVUM_NETWORK = {
  chainIdDecimal: 44005,
  chainIdHex: "0xabe5",
  chainName: "QDay Aevum Testnet",
  rpcUrl: "https://rpc-test.qday.info",
  explorerUrl: "https://explorer-test.qday.info",
  faucetUrl: "https://faucet.qday.info",
  discordUrl: "https://discord.gg/bYPhjmrSfK",
  nativeCurrency: {
    name: "Test QDAY",
    symbol: "tQDAY",
    decimals: 18
  },
  contracts: {
    // Verified live on QDay Aevum Testnet (Chain ID 44005)
    tUSD8: "0x456569838f1d43009A91ebA4263147Afd7233483",
    faucet: "0xE5074CBbd046AFb491EB8692abD6cF7ECCC6dEE5",
    // Deployed & live-verified on QDay Aevum Testnet (Chain ID 44005)
    registry: "0x16ED19F18f4A127992863a73251609d3070A79a1",
    escrow: "0x39cF3E460Ac8485b178076B24e1c40E40fbF6e23"
  },
  liveProof: {
    deployer: "0xB15f90BaB6BBc6f090D7522c4CFf3070CaFac856",
    registryTx: "0xfe547cd0764e6043da032e76ca694d7a65b4628966845d40cbd064ada4c8c445",
    escrowTx: "0xb1dbe2c04e5d76da086c352777d7563a90d56b5b769a87b19b7d544004e39928",
    settledInvoice1Tx: "0x2641c8d956593460d70e0f0b31ab56e392ae4ead3342da90f1bc1a2a7c66fdba",
    settledReceiptHash: "0xa576a8e3fa8432d0b64c99f74e66992db1a1f07137d0e8dccf519345fcee6edd",
    openInvoice2Id: "2",
    openInvoice2Tx: "0xd4605bedd66652ac47b83432a7e1e05e05cfef02d03daabfbba38d28563fc4f8"
  }
};

export const TUSD8_DECIMALS = 6;

export const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)"
];

export const REGISTRY_ABI = [
  "error InvalidHandle()",
  "function totalAgents() view returns (uint256)",
  "function rotationCooldown() view returns (uint64)",
  "function registerPayee(string handle, bytes32 legalEntityHash, string agentURI, (string metadataKey, bytes metadataValue)[] metadata) returns (uint256)",
  "function getPayeeProfile(uint256 agentId) view returns ((uint256 agentId, string handle, bytes32 handleHash, bytes32 legalEntityHash, address payoutWallet, address pendingPayoutWallet, uint64 rotationExecutableAt, uint64 registeredAt, uint64 updatedAt, uint64 profileEpoch, bool revoked, uint32 activeAttestations))",
  "function verifyPayeeByHandle(string handle, bytes32 expectedLegalHash, address expectedWallet) view returns ((uint8 status, uint256 resolvedAgentId, address activePayoutWallet, bytes32 activeHandleHash, bytes32 activeLegalHash, bool hasPendingRotation, bool isAttested))",
  "function verifyPayee(uint256 agentId, bytes32 expectedHandleHash, bytes32 expectedLegalHash, address expectedWallet) view returns ((uint8 status, uint256 resolvedAgentId, address activePayoutWallet, bytes32 activeHandleHash, bytes32 activeLegalHash, bool hasPendingRotation, bool isAttested))",
  "function revokePayee(uint256 agentId, bytes32 reasonHash)",
  "function finalizePayoutWalletRotation(uint256 agentId)",
  "function cancelPayoutWalletRotation(uint256 agentId)"
];

export const ESCROW_ABI = [
  "function invoiceCount() view returns (uint256)",
  "function createInvoice((uint256 payeeAgentId, bytes32 expectedHandleHash, bytes32 expectedLegalHash, address expectedPayoutWallet, address restrictedBuyer, uint256 amount, uint64 expiresAt, uint64 disputeWindow, uint8 mode, bool requireAttestation, bool strictNoPendingRotation, bytes32 metadataHash) params, (uint256 agentId, address expectedWallet, uint16 bps)[] splits) returns (uint256)",
  "function preflightCheck(uint256 invoiceId) view returns (bool payableNow, (uint8 status, uint256 resolvedAgentId, address activePayoutWallet, bytes32 activeHandleHash, bytes32 activeLegalHash, bool hasPendingRotation, bool isAttested) primaryCoP, string reason)",
  "function payInvoice(uint256 invoiceId, bytes32 buyerExpectedHandleHash, bytes32 buyerExpectedLegalHash, address buyerExpectedWallet) returns (bytes32)",
  "function releaseEscrow(uint256 invoiceId)",
  "function finalizeEscrow(uint256 invoiceId)",
  "function openDispute(uint256 invoiceId, bytes32 reasonHash)",
  "function resolveDispute(uint256 invoiceId, uint16 buyerRefundBps)",
  "function emergencyRefundInvalidatedPayee(uint256 invoiceId)",
  "function emergencyRefundRevokedPayee(uint256 invoiceId)",
  "function computeBoundInvoiceSalt(uint256 invoiceId, bytes32 userSalt) view returns (bytes32)",
  "function cancelInvoice(uint256 invoiceId)",
  "function getInvoice(uint256 invoiceId) view returns ((uint256 id, address issuer, uint256 payeeAgentId, bytes32 expectedHandleHash, bytes32 expectedLegalHash, address expectedPayoutWallet, address restrictedBuyer, address payer, uint256 amount, uint64 createdAt, uint64 expiresAt, uint64 disputeWindow, uint64 disputeDeadline, uint8 mode, uint8 status, bool requireAttestation, bool strictNoPendingRotation, bytes32 metadataHash, bytes32 receiptHash, bytes32 disputeReasonHash))",
  "function getInvoiceSplits(uint256 invoiceId) view returns ((uint256 agentId, address expectedWallet, uint16 bps)[])"
];
