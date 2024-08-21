// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title Payer (EVA)
/// @notice This contract holds funds as an intermediate between the EVABurnVault and the mining pools.
contract Payer is Ownable2Step {
    using SafeERC20 for IERC20;
    /// @notice The WBTC token contract used to pay to the EVABurnVault
    IERC20 immutable wbtc;
    /// @notice The address of the EVABurnVault contract
    address immutable evaBurnVault;

    event payment(uint256 amount);

    /// @notice Constructor sets the token to be used for payments
    constructor(
        address _payerWallet,
        address _wbtc,
        address _evaBurnVault
    ) Ownable(_payerWallet) {
        wbtc = IERC20(_wbtc);
        evaBurnVault = _evaBurnVault;
    }

    /// @notice Execute the payment to the EVABurnVault
    /// @param amount The amount of wBTC tokens to transfer
    function pay(uint256 amount) external onlyOwner {
        wbtc.transfer(evaBurnVault, amount);
        emit payment(amount);
    }
}
