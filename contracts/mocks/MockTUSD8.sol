// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockTUSD8
 * @notice Local-testing & demo mock matching QDay Aevum Testnet's live tUSD8 ERC-20
 *         (6 decimals; live contract at 0x456569838f1d43009A91ebA4263147Afd7233483).
 * @dev    Strictly for automated tests and local Hardhat simulation. Production Aevum
 *         deployments target the official live tUSD8 contract.
 */
contract MockTUSD8 is ERC20 {
    constructor() ERC20("tUSD8", "tUSD8") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
