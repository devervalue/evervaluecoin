// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @dev Local view of the legacy `SLSburnVault` contract (name kept CapWords per the style guide).
interface ISLSBurnVault {
    function increaseBacking(uint256 additionalEva, uint256 backingAmount) external;
    function backingToken() external view returns (IERC20);
}

/// @dev Local view of the legacy SLS vault factory; read for the currently active vault.
interface ISLSBurnVaultFactory {
    function activeVault() external view returns (address);
}

/// @dev Minimal EVALocker surface used by the router (rewards are pulled via transferFrom).
interface IEVALocker {
    function distribute(uint256 amount) external;
    function wbtc() external view returns (IERC20);
}

/// @dev Local view of the legacy core `EVABurnVault`; read once at construction to verify wiring.
interface ICoreBurnVault {
    function wbtcAddress() external view returns (address);
}

/**
 * @title RevenueRouter
 * @notice Holds the project's WBTC float and splits periodic payments across three sinks:
 *         the core burn vault, the active SLS ("boost") vault, and the EVALocker.
 * @dev Supersedes SLSPayer. Funded by direct WBTC transfers; the only outflow paths are pay()
 *      (to the three sinks) and rescue() (owner escape hatch). Split percentages are passed per
 *      call so the rate can be tuned operationally. For the SLS leg, mirrors SLSPayer: either tops
 *      up backing via increaseBacking (router must be an authorized payer on the active vault) or
 *      transfers directly; if there is no active vault, that portion falls back to the core vault.
 *      For the locker leg, the EVALocker pulls via transferFrom, so the router approves it and calls
 *      distribute() atomically — the router must be set as the locker's distributor.
 */
contract RevenueRouter is Ownable {
    using SafeERC20 for IERC20;

    /// @notice Basis-points denominator for the split percentages.
    uint16 public constant BPS = 10_000;

    /// @notice The revenue token (WBTC).
    IERC20 public immutable backingToken;
    /// @notice The core EVABurnVault sink.
    address public immutable coreVault;
    /// @notice The SLS vault factory, read for the active vault on each payment.
    ISLSBurnVaultFactory public immutable factory;
    /// @notice The EVALocker sink (this router must be its distributor).
    address public immutable locker;

    /// @notice Addresses authorized to call pay().
    mapping(address => bool) public isCallerAllowed;

    /// @notice An address was granted/revoked permission to call pay().
    event CallerUpdated(address indexed caller, bool allowed);
    /// @notice A revenue payment was split and forwarded to the three sinks.
    event PaymentExecuted(
        address indexed caller,
        uint256 totalAmount,
        uint256 coreAmount,
        uint256 slsAmount,
        uint256 lockerAmount,
        bool increasedSLS,
        uint256 additionalEva
    );
    /// @notice Tokens were recovered by the owner via the escape hatch.
    event Rescue(address indexed token, address indexed to, uint256 amount);
    /// @notice The active SLS vault is backed by a different token; its share was folded into the core leg.
    /// @dev Operational alarm: this means an SLS vault was created with a non-WBTC backing token. The
    ///      router never sends WBTC to such a vault because the vault can only ever move its own token.
    event SLSTokenMismatch(address indexed vault, address indexed vaultToken, uint256 foldedAmount);

    /// @dev Restricts pay() to the allowlisted operational callers.
    modifier onlyAllowed() {
        require(isCallerAllowed[msg.sender], "caller not allowed");
        _;
    }

    /**
     * @param _backingToken WBTC address.
     * @param _coreVault Core EVABurnVault address.
     * @param _factory SLS vault factory (read for the active vault).
     * @param _locker EVALocker address (must have this router set as distributor).
     * @param initialCallers Addresses authorized to call pay() from deployment.
     */
    constructor(
        address _backingToken,
        address _coreVault,
        address _factory,
        address _locker,
        address[] memory initialCallers
    ) Ownable(msg.sender) {
        require(_backingToken != address(0), "backingToken zero");
        require(_coreVault != address(0), "coreVault zero");
        require(_factory != address(0), "factory zero");
        require(_locker != address(0), "locker zero");
        // Wiring checks: every sink is immutable, so a token mismatch here would be permanent. The core
        // vault and the locker both expose their WBTC; require it to be the token this router moves.
        require(ICoreBurnVault(_coreVault).wbtcAddress() == _backingToken, "coreVault token mismatch");
        require(address(IEVALocker(_locker).wbtc()) == _backingToken, "locker token mismatch");

        backingToken = IERC20(_backingToken);
        coreVault = _coreVault;
        factory = ISLSBurnVaultFactory(_factory);
        locker = _locker;

        for (uint256 i = 0; i < initialCallers.length; i++) {
            isCallerAllowed[initialCallers[i]] = true;
            emit CallerUpdated(initialCallers[i], true);
        }
    }

    /**
     * @notice Split `amount` WBTC (held by this contract) across core / SLS / locker.
     * @param amount Total backing to distribute.
     * @param coreBps Share for the core burn vault, in basis points.
     * @param slsBps Share for the active SLS vault, in basis points.
     * @param lockerBps Share for the EVALocker, in basis points.
     * @param increaseSLS If true, top up SLS backing via increaseBacking; else transfer directly.
     * @param additionalEva EVA coverage to add when increaseSLS is true; ignored otherwise.
     * @dev coreBps + slsBps + lockerBps must equal BPS (10000).
     */
    function pay(
        uint256 amount,
        uint16 coreBps,
        uint16 slsBps,
        uint16 lockerBps,
        bool increaseSLS,
        uint256 additionalEva
    ) external onlyAllowed {
        require(amount > 0, "amount is zero");
        require(uint256(coreBps) + slsBps + lockerBps == BPS, "bps must sum to 10000");

        uint256 slsAmount = (amount * slsBps) / BPS;
        uint256 lockerAmount = (amount * lockerBps) / BPS;
        uint256 coreAmount = amount - slsAmount - lockerAmount; // remainder absorbs rounding

        // SLS leg
        address active = factory.activeVault();
        if (slsAmount > 0 && active != address(0)) {
            // Token identity guard: the factory can create a vault around any ERC-20, and a vault only
            // ever pays out its own backing token or EVA. WBTC sent to a non-WBTC vault would be stuck
            // forever, so on mismatch the SLS share folds into core instead (same as "no active vault").
            IERC20 vaultToken = ISLSBurnVault(active).backingToken();
            if (vaultToken != backingToken) {
                emit SLSTokenMismatch(active, address(vaultToken), slsAmount);
                coreAmount += slsAmount;
                slsAmount = 0;
            } else if (increaseSLS) {
                backingToken.forceApprove(active, 0);
                backingToken.forceApprove(active, slsAmount);
                ISLSBurnVault(active).increaseBacking(additionalEva, slsAmount);
            } else {
                backingToken.safeTransfer(active, slsAmount);
            }
        } else if (slsAmount > 0 && active == address(0)) {
            // no active SLS vault -> fold the SLS portion into core
            coreAmount += slsAmount;
            slsAmount = 0;
        }

        // Core leg
        if (coreAmount > 0) {
            backingToken.safeTransfer(coreVault, coreAmount);
        }

        // Locker leg (EVALocker pulls via transferFrom)
        if (lockerAmount > 0) {
            backingToken.forceApprove(locker, 0);
            backingToken.forceApprove(locker, lockerAmount);
            IEVALocker(locker).distribute(lockerAmount);
        }

        emit PaymentExecuted(msg.sender, amount, coreAmount, slsAmount, lockerAmount, increaseSLS, additionalEva);
    }

    /// @notice Allow or revoke an address authorized to call pay().
    /// @param caller The address to update.
    /// @param allowed Whether it may call pay().
    function setCaller(address caller, bool allowed) external onlyOwner {
        require(caller != address(0), "caller zero");
        isCallerAllowed[caller] = allowed;
        emit CallerUpdated(caller, allowed);
    }

    /// @notice Recover tokens accidentally sent here (owner escape hatch).
    /// @param token The token to recover (may be the backing token itself — see trust model docs).
    /// @param to Recipient of the recovered tokens.
    /// @param amount Amount to transfer.
    function rescue(address token, address to, uint256 amount) external onlyOwner {
        require(to != address(0), "to zero");
        IERC20(token).safeTransfer(to, amount);
        emit Rescue(token, to, amount);
    }
}
