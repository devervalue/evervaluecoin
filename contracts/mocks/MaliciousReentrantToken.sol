// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Functions the malicious token attempts to re-enter on the locker.
interface ILockerReenter {
    function claim(uint256 id) external;
    function withdraw(uint256 id) external;
    function earlyExit(uint256 id) external;
    function acceptRenewal(uint256 id) external;
    function lock(uint256 tierId, uint256 amount) external returns (uint256);
    function distribute(uint256 amount) external;
}

/// @notice Market function the malicious token attempts to re-enter.
interface IMarketReenter {
    function buy(uint256 id) external;
}

/**
 * @title MaliciousReentrantToken
 * @notice ERC20 that re-enters a target locker on transfer/transferFrom when armed.
 * @dev Used only in tests to prove the ReentrancyGuard blocks re-entrant calls. Configurable
 *      decimals so it can stand in for either EVA (18) or WBTC (8).
 */
contract MaliciousReentrantToken is ERC20 {
    uint8 private immutable _dec;
    address public target;
    uint256 public arg; // positionId or amount, depending on mode
    uint8 public mode; // 0 claim,1 withdraw,2 earlyExit,3 acceptRenewal,4 lock,5 distribute,6 market.buy
    bool public armed;

    constructor(uint8 dec_, uint256 supply) ERC20("Malicious", "MAL") {
        _dec = dec_;
        _mint(msg.sender, supply);
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function configure(address _target, uint8 _mode, uint256 _arg) external {
        target = _target;
        mode = _mode;
        arg = _arg;
    }

    function arm(bool on) external {
        armed = on;
    }

    function _maybeReenter() internal {
        if (!armed) return;
        armed = false; // single shot to avoid infinite recursion
        if (mode == 0) ILockerReenter(target).claim(arg);
        else if (mode == 1) ILockerReenter(target).withdraw(arg);
        else if (mode == 2) ILockerReenter(target).earlyExit(arg);
        else if (mode == 3) ILockerReenter(target).acceptRenewal(arg);
        else if (mode == 4) ILockerReenter(target).lock(0, arg);
        else if (mode == 5) ILockerReenter(target).distribute(arg);
        else IMarketReenter(target).buy(arg);
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        bool ok = super.transfer(to, amount);
        _maybeReenter();
        return ok;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        bool ok = super.transferFrom(from, to, amount);
        _maybeReenter();
        return ok;
    }
}
