// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title ReentrantTUSD8
 * @notice Adversarial ERC-20 test double that attempts reentrancy into a target escrow
 *         contract during `transfer` / `transferFrom` to verify ReentrancyGuard & CEI safety.
 */
contract ReentrantTUSD8 is ERC20 {
    address public attackTarget;
    bytes public attackCalldata;
    bool public armed;
    bool public reentryAttempted;
    bool public reentrySucceeded;

    constructor() ERC20("EvilTUSD8", "eUSD8") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function armAttack(address target, bytes calldata data) external {
        attackTarget = target;
        attackCalldata = data;
        armed = true;
        reentryAttempted = false;
        reentrySucceeded = false;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed && attackTarget != address(0)) {
            armed = false;
            reentryAttempted = true;
            (bool ok,) = attackTarget.call(attackCalldata);
            reentrySucceeded = ok;
        }
    }
}
