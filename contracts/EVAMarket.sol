// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "./EverValueCoin.sol";

/// @title EVAMarket
/// @notice A centralized market for buying and selling EVA tokens at administratively defined rates.
/// @dev This contract allows users to buy or sell EVA tokens using a defined market token, with adjustable rates and fees.
contract EVAMarket is Ownable2Step {
    using SafeERC20 for IERC20;
    using SafeERC20 for EverValueCoin;

    /// @notice The EverValueCoin (EVA) contract address
    EverValueCoin private immutable eva;
    /// @notice The market token used for buying and selling eva
    IERC20 private immutable marketToken;

    /// @notice The current price of 100 EVA tokens in the market token
    uint256 public marketTokenPer100Eva;

    /// @notice The fee for transactions, represented in perthousand (1/1000)
    uint256 public fee;

    /// @notice Emitted when a user buys EVA tokens with market tokens
    /// @param marketTokenFromUser The amount of market tokens spent by the user
    /// @param evaToUser The amount of EVA tokens received by the user
    event userBought(uint256 marketTokenFromUser, uint256 evaToUser);

    /// @notice Emitted when a user sells EVA tokens for market tokens
    /// @param marketTokenToUser The amount of market tokens received by the user
    /// @param evaFromUser The amount of EVA tokens sold by the user
    event userSold(uint256 marketTokenToUser, uint256 evaFromUser);

    /// @notice Constructor that sets up the market with the EVA, market token, initial rate, and fee
    /// @param _addrEva The address of the EVA contract
    /// @param _addrMarketToken The address of the market token
    /// @param _marketTokenPer100Eva The price of 100 EVA in market tokens
    /// @param _fee The transaction fee in perthousand (1/1000)
    constructor(
        address _addrEva,
        address _addrMarketToken,
        uint256 _marketTokenPer100Eva,
        uint256 _fee
    ) Ownable(msg.sender) {
        require(_addrEva != address(0), "Cannot set EVA to zero address");
        require(
            _addrMarketToken != address(0),
            "Cannot set market token to zero address"
        );
        require(_marketTokenPer100Eva > 0, "Rate must be greater than 0");
        require(_fee < 1000, "Fee must be lesser than 1000");

        eva = EverValueCoin(_addrEva);
        marketToken = IERC20(_addrMarketToken);

        marketTokenPer100Eva = _marketTokenPer100Eva;
        fee = _fee;
    }

    /// @notice Allows a user to buy EVA tokens with market tokens
    /// @param amount The amount of market tokens to spend
    function buy(uint256 amount) public {
        require(
            amount <= marketToken.balanceOf(msg.sender),
            "User doesn't have enough balance"
        );

        uint256 evaToUser = (amount * 100) / marketTokenPer100Eva;
        require(evaToUser > 0, "Amount too small");
        require(
            evaToUser <= eva.balanceOf(address(this)),
            "Market doesn't have enough EVA"
        );

        marketToken.safeTransferFrom(msg.sender, this.owner(), amount);
        eva.safeTransfer(msg.sender, evaToUser);

        emit userBought(amount, evaToUser);
    }

    /// @notice Allows a user to sell EVA tokens for market tokens
    /// @param amount The amount of EVA tokens to sell
    function sell(uint256 amount) public {
        require(
            amount <= eva.balanceOf(msg.sender),
            "User doesn't have enough EVA"
        );

        uint256 marketTokenToTransfer = (((amount * marketTokenPer100Eva) /
            100) * (1000 - fee)) / 1000;
        require(
            marketTokenToTransfer <= marketToken.balanceOf(address(this)),
            "Market doesn't have enough balance"
        );

        eva.safeTransferFrom(msg.sender, this.owner(), amount);
        marketToken.safeTransfer(msg.sender, marketTokenToTransfer);

        emit userSold(marketTokenToTransfer, amount);
    }

    /// @notice Allows the contract owner to set the price of 100 EVA tokens in market tokens
    /// @param _marketTokenPer100Eva The new price for 100 EVA in market tokens
    function setRate(uint256 _marketTokenPer100Eva) public onlyOwner {
        require(_marketTokenPer100Eva > 0, "Rate must be greater than 0");
        marketTokenPer100Eva = _marketTokenPer100Eva;
    }

    /// @notice Allows the contract owner to set the transaction fee for selling EVA tokens
    /// @param _fee The new fee to use, in perthousand (1/1000)
    function setFee(uint256 _fee) public onlyOwner {
        require(_fee < 1000, "Fee must be lesser than 1000");
        fee = _fee;
    }

    /// @notice Allows the contract owner to withdraw all tokens from the contract
    function withdrawAll() public onlyOwner {
        uint256 balanceEva = eva.balanceOf(address(this));
        uint256 balanceMarketToken = marketToken.balanceOf(address(this));

        eva.safeTransfer(this.owner(), balanceEva);
        marketToken.safeTransfer(this.owner(), balanceMarketToken);
    }
}
