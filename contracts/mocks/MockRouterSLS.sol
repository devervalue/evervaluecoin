// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title MockSLSVaultForRouter
/// @notice Minimal SLS vault that records increaseBacking calls and pulls the backing.
contract MockSLSVaultForRouter {
    using SafeERC20 for IERC20;

    IERC20 public immutable backingToken;
    uint256 public lastAdditionalEva;
    uint256 public totalPulled;

    constructor(address _backingToken) {
        backingToken = IERC20(_backingToken);
    }

    function increaseBacking(uint256 additionalEva, uint256 backingAmount) external {
        lastAdditionalEva = additionalEva;
        totalPulled += backingAmount;
        backingToken.safeTransferFrom(msg.sender, address(this), backingAmount);
    }
}

/// @title MockSLSFactoryForRouter
/// @notice Returns a settable activeVault address for RevenueRouter tests.
contract MockSLSFactoryForRouter {
    address public activeVault;

    function setActiveVault(address v) external {
        activeVault = v;
    }
}
