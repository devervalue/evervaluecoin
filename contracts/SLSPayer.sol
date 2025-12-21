// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface ISLSburnVault {
    function increaseBacking(uint256 additionalEva, uint256 backingAmount) external;
}

interface ISLSburnVaultFactory {
    function activeVault() external view returns (address);
}

/**
 * @title SLSPayer
 * @notice Funds distribution contract for periodic payments to the legacy burn vault and the active SLS vault.
 * @dev Assumes this contract holds backing tokens (e.g., WBTC) and, if using increaseBacking,
 *      is both the owner of the active SLS vault and authorized as a payer on that vault.
 */
contract SLSPayer is Ownable {
    using SafeERC20 for IERC20;

    uint16 public constant BPS = 10_000;

    IERC20 public immutable backingToken; // e.g., WBTC
    address public immutable burnVault;
    ISLSburnVaultFactory public immutable factory;

    mapping(address => bool) public isCallerAllowed;

    event CallerUpdated(address indexed caller, bool allowed);
    event PaymentExecuted(
        address indexed caller,
        uint256 totalAmount,
        uint256 burnVaultAmount,
        uint256 slsAmount,
        bool increasedSLS,
        uint256 additionalEva
    );
    event Rescue(address indexed token, address indexed to, uint256 amount);

    constructor(
        address _backingToken,
        address _burnVault,
        address _factory,
        address[] memory initialCallers
    ) Ownable(msg.sender) {
        require(_backingToken != address(0), "backingToken zero");
        require(_burnVault != address(0), "burnVault zero");
        require(_factory != address(0), "factory zero");
        backingToken = IERC20(_backingToken);
        burnVault = _burnVault;
        factory = ISLSburnVaultFactory(_factory);
        for (uint256 i = 0; i < initialCallers.length; i++) {
            isCallerAllowed[initialCallers[i]] = true;
            emit CallerUpdated(initialCallers[i], true);
        }
    }

    modifier onlyAllowed() {
        require(isCallerAllowed[msg.sender], "caller not allowed");
        _;
    }

    /**
     * @notice Execute a payment splitting between burnVault and the active SLS vault.
     * @param amount Total backing amount to distribute.
     * @param increaseSLS If true, attempt to increase backing on the active SLS vault; otherwise direct transfer.
     * @param additionalEva EVA coverage to add if increaseSLS is true; ignored otherwise.
     */
    function pay(uint256 amount, uint16 slsShareBps, bool increaseSLS, uint256 additionalEva) external onlyAllowed {
        require(amount > 0, "amount is zero");
        require(slsShareBps <= BPS, "share too high");
        uint256 slsAmount = (amount * slsShareBps) / BPS;
        uint256 burnAmount = amount - slsAmount;

        address active = factory.activeVault();

        // Send burn portion
        if (burnAmount > 0) {
            backingToken.safeTransfer(burnVault, burnAmount);
        }

        // Handle SLS portion
        if (slsAmount > 0 && active != address(0)) {
            if (increaseSLS) {
                // Approve the vault to pull backing; caller must ensure this contract is vault owner and payer.
                backingToken.forceApprove(active, 0);
                backingToken.forceApprove(active, slsAmount);
                ISLSburnVault(active).increaseBacking(additionalEva, slsAmount);
            } else {
                backingToken.safeTransfer(active, slsAmount);
            }
        } else if (slsAmount > 0 && active == address(0)) {
            // No active SLS vault; send all to burnVault
            backingToken.safeTransfer(burnVault, slsAmount);
            burnAmount += slsAmount;
            slsAmount = 0;
        }

        emit PaymentExecuted(msg.sender, amount, burnAmount, slsAmount, increaseSLS, additionalEva);
    }

    /**
     * @notice Update allowed caller.
     */
    function setCaller(address caller, bool allowed) external onlyOwner {
        require(caller != address(0), "caller zero");
        isCallerAllowed[caller] = allowed;
        emit CallerUpdated(caller, allowed);
    }

    /**
     * @notice Rescue tokens accidentally sent here.
     */
    function rescue(address token, address to, uint256 amount) external onlyOwner {
        require(to != address(0), "to zero");
        IERC20(token).safeTransfer(to, amount);
        emit Rescue(token, to, amount);
    }
}

