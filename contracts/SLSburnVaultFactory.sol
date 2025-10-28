// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./SLSburnVault.sol";
import "./EverValueCoin.sol";
import "./EVABurnVault.sol";

/// @title SLSburnVaultFactory
/// @notice Factory contract for creating and managing SLSburnVault instances with global EVA allocation tracking
/// @dev Ensures total EVA promises across all vaults never exceed total supply and provides centralized management
contract SLSburnVaultFactory is Ownable {
    using SafeERC20 for IERC20;
    using SafeERC20 for EverValueCoin;

    uint256 public constant ONE_EVA = 1 * 10**18;
    /// @notice The EverValueCoin (EVA) contract address
    EverValueCoin public immutable eva;
    IERC20 public immutable wbtc;
    EVABurnVault public immutable burnVault;

    /// @notice Array of all created vault addresses
    address[] public vaults;
    
    /// @notice Mapping from vault address to vault info
    mapping(address => VaultInfo) public vaultInfo;
    
    /// @notice Mapping from backing token to array of vault addresses using that token
    mapping(address => address[]) public vaultsByBackingToken;
    
    /// @notice Mapping from vault address to whether it is depleted
    mapping(address => bool) public vaultDepleted;
    
    /// @notice Whether new vault creation is paused
    bool public creationPaused;

    /// @notice Total number of active vaults (including original burnVault = 1)
    uint256 public totalVaultCount = 1;
    
    /// @notice Whether the original burnVault reservation has been initialized
    bool public originalVaultReserved = false;

    /// @notice Information about each vault
    struct VaultInfo {
        address backingToken;
        uint256 fixedEvaAmount;
        uint256 createdAt;
    }

    /// @notice Emitted when a new vault is created
    /// @param vault The address of the created vault
    /// @param creator The address that created the vault
    /// @param backingToken The backing token address
    /// @param fixedEvaAmount The EVA amount this vault covers
    event VaultCreated(
        address indexed vault,
        address indexed creator,
        address indexed backingToken,
        uint256 fixedEvaAmount
    );



    /// @notice Emitted when creation is paused or unpaused
    /// @param paused Whether creation is now paused
    event CreationPauseToggled(bool paused);

    /// @notice Emitted when a vault is depleted and removed from active count
    /// @param vault The address of the depleted vault
    event VaultDepleted(address indexed vault);
    
    /// @notice Emitted when the original burnVault reservation is initialized
    event OriginalVaultReserved();

    /// @notice Emitted when the last burnVault withdrawal is made
    event LastBurnVaultWithdraw();

    /// @notice Constructor sets the EVA token address
    /// @param _evaAddress The address of the EVA token contract
    constructor(address _evaAddress, address _burnVaultAddress, address _wbtcAddress) Ownable(msg.sender) {
        require(_evaAddress != address(0), "EVA address cannot be zero");
        require(_burnVaultAddress != address(0), "Burn vault address cannot be zero");
        require(_wbtcAddress != address(0), "WBTC address cannot be zero");
        eva = EverValueCoin(_evaAddress);
        burnVault = EVABurnVault(_burnVaultAddress);
        wbtc = IERC20(_wbtcAddress);
    }
    
    /// @notice Initializes the reservation for the original burnVault by locking 1 EVA in the factory
    /// @dev Can only be called once by the owner. Requires 1 EVA to be transferred to the factory first.
    function initializeOriginalVaultReservation() external onlyOwner {
        require(!originalVaultReserved, "Original vault already reserved");
        require(eva.balanceOf(address(this)) >= 1, "Factory must have at least 1 EVA");
        
        originalVaultReserved = true;
        
        emit OriginalVaultReserved();
    }

    /// @notice Withdraws the last burnVault withdrawal
    /// @dev Can only be called once by the owner. Requires the original vault reservation to be initialized first.
    function finalBurnVaultWithdraw() external onlyOwner {
        require(originalVaultReserved, "Must initialize original vault reservation first");
        require(eva.balanceOf(address(this)) >= 1, "Factory must have at least 1 EVA");
        require(eva.totalSupply() <= totalVaultCount * ONE_EVA, "EVA total supply must be less than or equal to total vault count");
        //Using total eva balance to prevent eva locked in case of accidental transfers to the factory
        eva.approve(address(burnVault), eva.balanceOf(address(this)));
        burnVault.backingWithdraw(eva.balanceOf(address(this)));
        wbtc.safeTransfer(msg.sender, wbtc.balanceOf(address(this)));
        emit LastBurnVaultWithdraw();
    }

    /// @notice Creates a new SLSburnVault with specified parameters (only owner)
    /// @dev Only the factory owner can create new vaults
    /// @param backingToken The address of the backing token
    /// @param fixedEvaAmount The amount of EVA tokens this vault will cover
    /// @param initialBacking The initial backing token amount to deposit
    /// @return vaultAddress The address of the created vault
    function createVault(
        address backingToken,
        uint256 fixedEvaAmount,
        uint256 initialBacking
    ) external onlyOwner returns (address vaultAddress) {
        require(originalVaultReserved, "Must initialize original vault reservation first");
        require(!creationPaused, "Vault creation is paused");
        require(backingToken != address(0), "Backing token cannot be zero address");
        require(fixedEvaAmount > 0, "Fixed EVA amount must be greater than 0");
        

        // Deploy new vault
        SLSburnVault newVault = new SLSburnVault(
            address(eva),
            backingToken,
            fixedEvaAmount,
            address(this)
        );
        
        vaultAddress = address(newVault);

        // Transfer initial backing to vault if specified
        if (initialBacking > 0) {
            IERC20(backingToken).safeTransferFrom(msg.sender, vaultAddress, initialBacking);
        }

        // Transfer 1 EVA to vault for final withdrawal mechanism
        eva.safeTransferFrom(msg.sender, vaultAddress, ONE_EVA);
        
        // Update tracking
        vaults.push(vaultAddress);
        vaultsByBackingToken[backingToken].push(vaultAddress);
        totalVaultCount++;
        
        vaultInfo[vaultAddress] = VaultInfo({
            backingToken: backingToken,
            fixedEvaAmount: fixedEvaAmount - ONE_EVA, // Subtract 1 EVA for the last withdrawal
            createdAt: block.timestamp
        });

        // Transfer ownership of vault to creator
        newVault.transferOwnership(msg.sender);

        emit VaultCreated(vaultAddress, msg.sender, backingToken, fixedEvaAmount - ONE_EVA);
        
        return vaultAddress;
    }

    /// @notice Gets the total backing amount across all vaults using a specific token
    /// @dev Loops through all vaults to calculate real-time backing totals
    /// @param backingToken The address of the backing token to query
    /// @return totalBacking The total amount of backing tokens across all vaults using this token
    function getTotalBackingByToken(address backingToken) external view returns (uint256 totalBacking) {
        address[] memory tokenVaults = vaultsByBackingToken[backingToken];
        
        for (uint256 i = 0; i < tokenVaults.length; i++) {
                totalBacking += IERC20(backingToken).balanceOf(tokenVaults[i]);
        }
        
        return totalBacking;
    }

    /// @notice Called by vaults when they are completely depleted (fixedEvaAmount = 0)
    function onVaultDepletion() external {
        address vault = msg.sender;
        require(vaultInfo[vault].createdAt > 0, "Invalid vault address");
        vaultDepleted[vault] = true;
        // Decrease total vault count
        totalVaultCount--;        
        emit VaultDepleted(vault);
    }


    /// @notice Pauses or unpauses vault creation
    /// @param paused Whether to pause creation
    function setCreationPaused(bool paused) external onlyOwner {
        creationPaused = paused;
        emit CreationPauseToggled(paused);
    }

    // VIEW FUNCTIONS

    /// @notice Gets the total number of vaults created
    /// @return The number of vaults
    function getVaultCount() external view returns (uint256) {
        return vaults.length;
    }

    /// @notice Gets all vault addresses
    /// @return Array of vault addresses
    function getAllVaults() external view returns (address[] memory) {
        return vaults;
    }

    /// @notice Gets all vaults using a specific backing token
    /// @param backingToken The backing token address
    /// @return Array of vault addresses
    function getVaultsByBackingToken(address backingToken) external view returns (address[] memory) {
        return vaultsByBackingToken[backingToken];
    }


    /// @notice Checks if an address is a vault created by this factory
    /// @param vault The address to check
    /// @return Whether the address is a valid vault
    function isValidVault(address vault) external view returns (bool) {
        return vaultInfo[vault].createdAt > 0;
    }
}
