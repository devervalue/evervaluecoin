// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./EverValueCoin.sol";

/**
 * @title Interface for SLSburnVaultFactory
 * @notice Minimal functions used by SLSburnVault to report depletion and read vault count.
 */
interface ISLSburnVaultFactory {
    function totalVaultCount() external view returns (uint256);
    function onVaultDepletion() external;
}

/**
 * @title SLSburnVault
 * @notice Single-backup vault where users burn EVA to redeem proportional backing.
 * @dev No per-vault EVA reserve and no global totalSupply dependency.
 *      Depletion is auto-marked when the allocation reaches zero (single active vault model).
 *      Emergency withdrawals let the admin recover stray tokens:
 *        - EVA at any time
 *        - Backing only after depletion.
 */
contract SLSburnVault is Ownable {
    using SafeERC20 for IERC20;
    using SafeERC20 for EverValueCoin;

    uint256 public constant ONE_EVA = 1e18;

    IERC20 public immutable backingToken;
    EverValueCoin public immutable eva;
    ISLSburnVaultFactory public immutable factory;

    /// @notice Remaining EVA allocation this vault covers (decreases as users burn).
    uint256 public fixedEvaAmount;
    /// @notice Flag set once the vault is fully depleted and reported to factory.
    bool public hasBeenDepleted;
    /// @notice Addresses allowed to call increaseBacking.
    mapping(address => bool) public isPayer;

    event BurnMade(uint256 evaBurned, uint256 backingWithdrew);
    event Depleted(address vault);
    event EmergencyWithdrawBacking(address to, uint256 backingAmount);
    event EmergencyWithdrawEVA(address to, uint256 evaAmount);
    event BackingIncreased(uint256 additionalEva, uint256 backingAdded);
    event PayerUpdated(address indexed payer, bool allowed);

    /**
     * @param _addrEva Address of EVA token.
     * @param _addrBackingToken Address of backing token.
     * @param _fixedEvaAmount Total EVA this vault will cover (full amount, no reserve subtraction).
     * @param _factory Address of the factory.
     */
    constructor(
        address _addrEva,
        address _addrBackingToken,
        uint256 _fixedEvaAmount,
        address _factory
    ) Ownable(msg.sender) {
        require(_addrEva != address(0), "Cannot set EVA to zero address");
        require(_addrBackingToken != address(0), "Cannot set backing token to zero address");
        require(_factory != address(0), "Cannot set factory to zero address");
        require(_fixedEvaAmount >= ONE_EVA, "Fixed EVA amount must be >= 1 EVA");

        eva = EverValueCoin(_addrEva);
        require(_fixedEvaAmount <= eva.totalSupply(), "Fixed EVA exceeds total supply");

        backingToken = IERC20(_addrBackingToken);
        factory = ISLSburnVaultFactory(_factory);

        fixedEvaAmount = _fixedEvaAmount;
        isPayer[msg.sender] = true;
        emit PayerUpdated(msg.sender, true);
    }

    /**
     * @notice Burn EVA to withdraw proportional backing.
     * @param amount EVA amount to burn.
     */
    function backingWithdraw(uint256 amount) external  {
        uint256 effectiveEvaAmount = getEffectiveEvaAmount();
        require(effectiveEvaAmount > 0, "No EVA remaining");
        require(amount <= effectiveEvaAmount, "Amount exceeds remaining EVA");

        uint256 backingBal = backingToken.balanceOf(address(this));
        require(backingBal > 0, "Nothing to withdraw");

        uint256 backingToTransfer = (amount * backingBal) / effectiveEvaAmount;
        require(backingToTransfer > 0, "Nothing to withdraw");

        fixedEvaAmount -= amount;
        eva.burnFrom(msg.sender, amount);
        backingToken.safeTransfer(msg.sender, backingToTransfer);

        emit BurnMade(amount, backingToTransfer);

        if (fixedEvaAmount == 0 && !hasBeenDepleted) {
            hasBeenDepleted = true;
            factory.onVaultDepletion();
            emit Depleted(address(this));
        }
    }

    /**
     * @notice Effective EVA this vault can currently cover.
     * @return Remaining EVA allocation.
     */
    function getEffectiveEvaAmount() public view returns (uint256) {
        return fixedEvaAmount;
    }

    /**
     * @notice Quote the current backing output for a given EVA burn amount.
     * @param amount EVA amount to quote (use 1e18 to get per-EVA rate).
     * @return backingOut Backing tokens the user would receive at current state; returns 0 if not withdrawable.
     */
    function getBurningQuote(uint256 amount) external view returns (uint256 backingOut) {
        uint256 effectiveEvaAmount = getEffectiveEvaAmount();
        if (effectiveEvaAmount == 0) {
            return 0;
        }
        uint256 backingBal = backingToken.balanceOf(address(this));
        if (backingBal == 0) {
            return 0;
        }
        if (amount > effectiveEvaAmount) {
            amount = effectiveEvaAmount;
        }
        backingOut = (amount * backingBal) / effectiveEvaAmount;
    }

    /**
     * @notice Tops up backing and optionally increases EVA allocation. Callable by authorized payers.
     * @param additionalEva Additional EVA allocation to cover (can be 0).
     * @param backingAmount Backing to deposit. Must be > 0.
     * @dev Price guard applies only when additionalEva > 0:
     *      (currentBacking + backingAmount)/(fixedEvaAmount + additionalEva) >= currentBacking/fixedEvaAmount
     *      implemented as backingAmount * fixedEvaAmount >= currentBacking * additionalEva.
     *      When additionalEva == 0, the call simply raises the price by adding backing.
     */
    function increaseBacking(uint256 additionalEva, uint256 backingAmount) external {
        require(isPayer[msg.sender], "Not authorized payer");
        require(!hasBeenDepleted, "Vault is depleted");
        require(backingAmount > 0, "backingAmount is zero");

        uint256 currentBacking = backingToken.balanceOf(address(this));

        if (additionalEva > 0) {
            require(backingAmount * fixedEvaAmount >= currentBacking * additionalEva, "Price would decrease");
            fixedEvaAmount += additionalEva;
            require(fixedEvaAmount <= eva.totalSupply(), "Fixed EVA amount exceeds total supply");
        }

        backingToken.safeTransferFrom(owner(), address(this), backingAmount);

        emit BackingIncreased(additionalEva, backingAmount);
    }

    /**
     * @notice Owner sets or unsets a payer authorized to call increaseBacking.
     * @param payer Address to update.
     * @param allowed True to allow, false to revoke.
     */
    function setPayer(address payer, bool allowed) external onlyOwner {
        require(payer != address(0), "Invalid payer");
        isPayer[payer] = allowed;
        emit PayerUpdated(payer, allowed);
    }

    /**
     * @notice Emergency: recover backing tokens after depletion (e.g., if backing arrives post-depletion).
     * @dev Requires vault to be marked depleted and allocation to be zero.
     */
    function emergencyWithdrawBacking() external onlyOwner {
        require(hasBeenDepleted && fixedEvaAmount == 0, "Not depleted");
        uint256 backingBal = backingToken.balanceOf(address(this));
        backingToken.safeTransfer(owner(), backingBal);
        emit EmergencyWithdrawBacking(owner(), backingBal);
    }

    /**
     * @notice Emergency: recover any EVA sent by mistake at any time.
     */
    function emergencyWithdrawEVA() external onlyOwner {
        uint256 evaBal = eva.balanceOf(address(this));
        eva.safeTransfer(owner(), evaBal);
        emit EmergencyWithdrawEVA(owner(), evaBal);
    }
}