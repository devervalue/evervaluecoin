// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/// @title MockSLSburnVaultFactory
/// @notice Mock factory for testing SLSburnVault in isolation
contract MockSLSburnVaultFactory {
    /// @notice Simulated total vault count
    uint256 public totalVaultCount;
    
    /// @notice Counter to track how many times onVaultDepletion was called
    uint256 public depletionCallCount;
    
    /// @notice Mapping to track which vaults reported depletion
    mapping(address => uint256) public vaultDepletionCalls;
    
    /// @notice Last vault that called onVaultDepletion
    address public lastDepletedVault;
    
    /// @notice Constructor sets initial vault count
    /// @param _initialCount Initial vault count to return
    constructor(uint256 _initialCount) {
        totalVaultCount = _initialCount;
    }
    
    /// @notice Set the vault count to be returned
    /// @param _count New vault count
    function setTotalVaultCount(uint256 _count) external {
        totalVaultCount = _count;
    }
    
    /// @notice Mock implementation that tracks calls
    function onVaultDepletion() external {
        depletionCallCount++;
        vaultDepletionCalls[msg.sender]++;
        lastDepletedVault = msg.sender;
    }
    
    /// @notice Reset the depletion counter (useful for tests)
    function resetDepletionCount() external {
        depletionCallCount = 0;
        lastDepletedVault = address(0);
    }
    
    /// @notice Get how many times a specific vault called onVaultDepletion
    /// @param vault The vault address to check
    /// @return Number of times the vault reported depletion
    function getVaultDepletionCalls(address vault) external view returns (uint256) {
        return vaultDepletionCalls[vault];
    }
}