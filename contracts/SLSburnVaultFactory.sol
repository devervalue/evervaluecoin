// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./SLSburnVault.sol";
import "./EverValueCoin.sol";
import "./EVABurnVault.sol";

/**
 * @title SLSburnVaultFactory
 * @notice Admin-controlled factory to create and track SLSburnVaults.
 * @dev Single-active-vault model: only one SLS vault may exist at a time.
 *      Creation requires prior vault depletion. No original-reservation logic.
 */
contract SLSburnVaultFactory is Ownable {
    using SafeERC20 for IERC20;
    using SafeERC20 for EverValueCoin;

    EverValueCoin public immutable eva;

    address[] public vaults;
    mapping(address => VaultInfo) public vaultInfo;
    mapping(address => address[]) public vaultsByBackingToken;
    mapping(address => bool) public vaultDepleted;

    bool public creationPaused;
    uint256 public totalVaultCount = 0; // counts only SLS vaults
    address public activeVault;         // only one SLS vault at a time

    struct VaultInfo {
        address backingToken;
        uint256 fixedEvaAmount;
        uint256 createdAt;
    }

    event VaultCreated(address indexed vault, address indexed creator, address indexed backingToken, uint256 fixedEvaAmount);
    event CreationPauseToggled(bool paused);
    event VaultDepleted(address indexed vault);
    event LastBurnVaultWithdraw();

    /**
     * @param _evaAddress EVA token address.
     */
    constructor(address _evaAddress) Ownable(msg.sender) {
        require(_evaAddress != address(0), "EVA address cannot be zero");
        eva = EverValueCoin(_evaAddress);
    }

    /**
     * @notice Create a new SLS vault. Only one active SLS vault is allowed.
     * @param backingToken Backing token address.
     * @param fixedEvaAmount EVA allocation this vault will cover.
     * @param initialBacking Amount of backing to fund at creation (optional).
     */
    function createVault(
        address backingToken,
        uint256 fixedEvaAmount,
        uint256 initialBacking
    ) external onlyOwner returns (address vaultAddress) {
        require(!creationPaused, "Vault creation is paused");
        require(activeVault == address(0), "Deplete current vault first");
        require(backingToken != address(0), "Backing token cannot be zero address");
        require(fixedEvaAmount > 0, "Fixed EVA amount must be greater than 0");

        SLSburnVault newVault = new SLSburnVault(
            address(eva),
            backingToken,
            fixedEvaAmount,
            address(this)
        );

        vaultAddress = address(newVault);

        if (initialBacking > 0) {
            IERC20(backingToken).safeTransferFrom(msg.sender, vaultAddress, initialBacking);
        }

        vaults.push(vaultAddress);
        vaultsByBackingToken[backingToken].push(vaultAddress);
        totalVaultCount++;

        vaultInfo[vaultAddress] = VaultInfo({
            backingToken: backingToken,
            fixedEvaAmount: fixedEvaAmount,
            createdAt: block.timestamp
        });

        activeVault = vaultAddress;
        newVault.transferOwnership(msg.sender);
        emit VaultCreated(vaultAddress, msg.sender, backingToken, fixedEvaAmount);
    }

    /**
     * @notice Called by the active vault exactly once when it is fully depleted.
     */
    function onVaultDepletion() external {
        address vault = msg.sender;
        require(vault == activeVault, "Only active vault can deplete");


        vaultDepleted[vault] = true;
        totalVaultCount--;
        activeVault = address(0);

        emit VaultDepleted(vault);
    }

    /**
     * @notice Pause or unpause vault creation.
     * @param paused True to pause, false to unpause.
     */
    function setCreationPaused(bool paused) external onlyOwner {
        creationPaused = paused;
        emit CreationPauseToggled(paused);
    }

    /// @notice Number of vaults ever created.
    function getVaultCount() external view returns (uint256) {
        return vaults.length;
    }

    /// @notice All vault addresses.
    function getAllVaults() external view returns (address[] memory) {
        return vaults;
    }

    /// @notice Vaults by backing token.
    function getVaultsByBackingToken(address backingToken) external view returns (address[] memory) {
        return vaultsByBackingToken[backingToken];
    }

    /// @notice True if address was created by this factory.
    function isValidVault(address vault) external view returns (bool) {
        return vaultInfo[vault].createdAt > 0;
    }

    /**
     * @notice Total backing across all vaults for a given token (view-only; O(n)).
     * @param backingToken The backing token address.
     * @return totalBacking Sum of balances across vaults for the token.
     */
    function getTotalBackingByToken(address backingToken) external view returns (uint256 totalBacking) {
        address[] memory tokenVaults = vaultsByBackingToken[backingToken];
        for (uint256 i = 0; i < tokenVaults.length; i++) {
            totalBacking += IERC20(backingToken).balanceOf(tokenVaults[i]);
        }
    }
}