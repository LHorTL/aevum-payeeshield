// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC8004PayeeRegistry} from "../interfaces/IERC8004PayeeRegistry.sol";

/**
 * @title ReentrantERC721Receiver
 * @notice Adversarial ERC-721 receiver testing CEI + ReentrancyGuard around `_safeMint`:
 *         Mode 1: Attempts to re-enter `registerPayee` with the exact same handle during `_safeMint`.
 *         Mode 2: Immediately calls `transferFrom(this, victim, tokenId)` during `_safeMint` to test
 *                 whether transfer-safety wallet reset holds without being overwritten post-callback.
 */
contract ReentrantERC721Receiver is IERC721Receiver {
    IERC8004PayeeRegistry public immutable registry;
    uint8 public attackMode; // 1 = reenter registerPayee, 2 = transferFrom inside callback
    address public victim;
    string public targetHandle;
    bytes32 public targetLegalHash;

    bool public callbackHit;
    bool public reentrySucceeded;
    bool public transferInsideCallbackSucceeded;

    constructor(address _registry) {
        registry = IERC8004PayeeRegistry(_registry);
    }

    function launchRegisterAttack(
        uint8 mode,
        address _victim,
        string calldata handle,
        bytes32 legalHash
    ) external returns (uint256 agentId) {
        attackMode = mode;
        victim = _victim;
        targetHandle = handle;
        targetLegalHash = legalHash;
        callbackHit = false;
        reentrySucceeded = false;
        transferInsideCallbackSucceeded = false;

        IERC8004PayeeRegistry.MetadataEntry[] memory empty = new IERC8004PayeeRegistry.MetadataEntry[](0);
        agentId = registry.registerPayee(handle, legalHash, "ipfs://attacker.json", empty);
    }

    function onERC721Received(address, address, uint256 tokenId, bytes calldata) external override returns (bytes4) {
        callbackHit = true;
        if (attackMode == 1) {
            attackMode = 0;
            IERC8004PayeeRegistry.MetadataEntry[] memory empty = new IERC8004PayeeRegistry.MetadataEntry[](0);
            try registry.registerPayee(targetHandle, targetLegalHash, "ipfs://dup.json", empty) {
                reentrySucceeded = true;
            } catch {
                reentrySucceeded = false;
            }
        } else if (attackMode == 2) {
            attackMode = 0;
            try IERC721(address(registry)).transferFrom(address(this), victim, tokenId) {
                transferInsideCallbackSucceeded = true;
            } catch {
                transferInsideCallbackSucceeded = false;
            }
        }
        return IERC721Receiver.onERC721Received.selector;
    }
}
