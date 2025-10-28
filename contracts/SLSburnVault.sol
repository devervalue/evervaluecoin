// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./EverValueCoin.sol";

/// @notice Interface for SLSburnVaultFactory to get vault count and report depletion
interface ISLSburnVaultFactory {
    function totalVaultCount() external view returns (uint256);
    function onVaultDepletion() external;
}

/// @title SLSburnVault
/// @notice A secondary liquidity source vault that allows users to burn EVA tokens in exchange for backing tokens for a fixed EVA amount.
/// @dev This contract facilitates the burning of EVA tokens and ensures fair distribution of backing tokens based on a fixed EVA pool.
contract SLSburnVault is Ownable {
    using SafeERC20 for IERC20;
    using SafeERC20 for EverValueCoin;

    uint256 public constant ONE_EVA = 1 * 10**18;
    /// @notice The backing token contract address
    IERC20 immutable backingToken;
    /// @notice The EverValueCoin (EVA) contract address
    EverValueCoin immutable eva;
    /// @notice The factory contract address
    ISLSburnVaultFactory immutable factory;
    /// @notice The publicly accessible address of the backing token contract
    address public backingTokenAddress;

    /// @notice The current amount of EVA tokens this vault covers (decreases as tokens are burned)
    uint256 public fixedEvaAmount;

    /// @notice Whether the vault has been depleted
    bool public hasBeenDepleted = false;

    /// @notice Emitted when a user burns EVA tokens and withdraws backing tokens
    /// @param evaBurned The amount of EVA tokens burned
    /// @param backingWithdrew The amount of backing tokens withdrawn
    event burnMade(uint256 evaBurned, uint256 backingWithdrew);

    /// @notice Emitted when backing is increased for more EVA coverage
    /// @param backingAdded The amount of backing tokens added
    /// @param evaAmountCovered The additional EVA amount covered by the backing
    event backingIncreased(uint256 backingAdded, uint256 evaAmountCovered);


    /// @notice Constructor that sets up the vault with the EVA and backing token addresses and initial EVA amount and reserves 1 EVA for the last withdrawal
    /// @param _addrEva The address of the EVA token contract
    /// @param _addrBackingToken The address of the backing token contract
    /// @param _fixedEvaAmount The fixed amount of EVA tokens this vault will cover
    /// @param _factory The address of the factory contract
    constructor(address _addrEva, address _addrBackingToken, uint256 _fixedEvaAmount, address _factory) Ownable(msg.sender) {
        require(_addrEva != address(0), "Cannot set EVA to zero address");
        require(_addrBackingToken != address(0), "Cannot set backing token to zero address");
        require(_factory != address(0), "Cannot set factory to zero address");
        require(_fixedEvaAmount >= ONE_EVA, "Fixed EVA amount must be greater than or equal to 1 EVA");

        eva = EverValueCoin(_addrEva);
        require(_fixedEvaAmount <= eva.totalSupply(), "Fixed EVA amount cannot exceed total supply");

        backingToken = IERC20(_addrBackingToken);
        backingTokenAddress = _addrBackingToken;
        factory = ISLSburnVaultFactory(_factory);
        
        //Always reserve 1 EVA for the last withdrawal
        fixedEvaAmount = _fixedEvaAmount - ONE_EVA;
    }

    /// @notice Withdraws a proportional amount of backing tokens by burning EVA tokens
    /// @dev The amount of backing tokens to withdraw is based on the EVA burned and the current backing token balance relative to the fixed EVA amount
    /// @param amount The amount of EVA tokens to burn
    function backingWithdraw(uint256 amount) public {
        uint256 effectiveEvaAmount = getEffectiveEvaAmount();
        require(effectiveEvaAmount > 0, "No EVA amount remaining in this vault");
        require(amount <= effectiveEvaAmount, "Amount exceeds remaining EVA in vault");
        require(backingToken.balanceOf(address(this)) > 0, "Nothing to withdraw");

        // Add 1 EVA to the effective EVA amount to account for the last withdrawal
        uint256 backingToTransfer = (amount * backingToken.balanceOf(address(this))) / (effectiveEvaAmount + ONE_EVA);
        require(backingToTransfer > 0, "Nothing to withdraw");

        // Reduce the fixed EVA amount
        fixedEvaAmount -= amount;

        // Burn EVA tokens from user
        eva.burnFrom(msg.sender, amount);
        
        // Transfer proportional backing tokens to user
        backingToken.safeTransfer(msg.sender, backingToTransfer);

        emit burnMade(amount, backingToTransfer);
    }

    /// @notice Gets the effective EVA amount this vault can actually cover
    /// @dev Returns minimum of fixedEvaAmount and (totalSupply - totalVaultCount) to ensure enough EVA remains for all vaults
    /// @return The effective EVA amount considering current total supply and vault count
    function getEffectiveEvaAmount() public view returns (uint256) {
        uint256 currentTotalSupply = eva.totalSupply();
        uint256 vaultCount = factory.totalVaultCount();        
        // Available EVA pool = totalSupply - vaultCount (reserving 1 EVA per vault)
        // Convert vaultCount to wei for proper comparison (vaultCount * 1e18)
        uint256 reservedEva = vaultCount * ONE_EVA;
        uint256 availableEvaPool = currentTotalSupply > reservedEva ? currentTotalSupply - reservedEva : 0;
        
        return fixedEvaAmount < availableEvaPool ? fixedEvaAmount : availableEvaPool;
    }

    /// @notice Admin function to withdraw remaining backing when system is in final state
    /// @dev Can only be called when effectiveEvaAmount is 0
    /// @dev if vault has been depletead but for some reason it recives backingToken and EVA, admin can call this function to re-depleate it without recalling the onVaultDepletion logic on SLSburnVaultFactory.
    /// @dev if vault has been depleated but for some reasion it recives only backingToken or only EVA, admin can transfer EVA or backingToken to allow execution and empty the vault without recalling the onVaultDepletion logic on SLSburnVaultFactory.
    function adminFinalWithdraw() external onlyOwner {
        uint256 effectiveEvaAmount = getEffectiveEvaAmount();
        // Convert vaultCount to wei for proper comparison (vaultCount * 1e18)
        require(effectiveEvaAmount == 0, "Can only withdraw when effective EVA amount is 0");
        
        uint256 backingBalance = backingToken.balanceOf(address(this));
        uint256 evaBalance = eva.balanceOf(address(this));
        // Burn the locked EVA (always 1 EVA, guaranteed by factory at vault creation)
        eva.burn(evaBalance);
        if(!hasBeenDepleted) {
            factory.onVaultDepletion();
            hasBeenDepleted = true;
        }
        
        // Transfer all remaining backing to owner
        backingToken.safeTransfer(owner(), backingBalance);        
        emit burnMade(evaBalance, backingBalance);
    }

}
