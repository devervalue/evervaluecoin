// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./EverValueCoin.sol";

/// @title EVABurnVault
/// @notice A vault that allows users to burn EVA tokens in exchange for backing wBTC tokens.
/// @dev This contract facilitates the burning of EVA tokens and ensures fair distribution of wBTC tokens.
contract EVABurnVault {
    using SafeERC20 for IERC20;
    using SafeERC20 for EverValueCoin;

    /// @notice The wBTC token contract address
    IERC20 immutable wbtc;
    /// @notice The EverValueCoin (EVA) contract address
    EverValueCoin immutable eva;
    /// @notice The publicly accessible address of the wBTC token contract
    address public wbtcAddress;

    /// @notice Emitted when a user burns EVA tokens and withdraws wBTC tokens
    /// @param evaBurned The amount of EVA tokens burned
    /// @param wbtcWithdrew The amount of wBTC tokens withdrawn
    event burnMade(uint256 evaBurned, uint256 wbtcWithdrew);

    /// @notice Constructor that sets up the vault with the EVA and wBTC token addresses
    /// @param _addrEva The address of the EVA token contract
    /// @param _addrWbtc The address of the wBTC token contract
    constructor(address _addrEva, address _addrWbtc) {
        require(_addrEva != address(0), "Cannot set EVA to zero address");
        require(_addrWbtc != address(0), "Cannot set wBTC to zero address");

        eva = EverValueCoin(_addrEva);
        wbtc = IERC20(_addrWbtc);
        wbtcAddress = _addrWbtc;
    }

    /// @notice Withdraws a proportional amount of backing wBTC tokens by burning EVA tokens
    /// @dev The amount of wBTC tokens to withdraw is based on the EVA burned and the current wBTC balance
    /// @param amount The amount of EVA tokens to burn
    function backingWithdraw(uint256 amount) public {
        uint256 totalSupply = eva.totalSupply();

        require(
            totalSupply > 0,
            "Unable to withdraw with 0 total supply of EVA tokens"
        );
        require(wbtc.balanceOf(address(this)) > 0, "Nothing to withdraw");

        uint256 wbtcToTransfer = (amount * wbtc.balanceOf(address(this))) /
            totalSupply;
        require(wbtcToTransfer > 0, "Nothing to withdraw");

        eva.burnFrom(msg.sender, amount);
        wbtc.safeTransfer(msg.sender, wbtcToTransfer);

        emit burnMade(amount, wbtcToTransfer);
    }
}
