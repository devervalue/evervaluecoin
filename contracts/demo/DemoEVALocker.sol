// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {EVALocker} from "../EVALocker.sol";

/**
 * @title DemoEVALocker
 * @notice TESTNET/DEMO ONLY. Identical to EVALocker but with an admin-controllable clock so time can be
 *         fast-forwarded on a public testnet (where the EVM clock can't be warped). NEVER deploy to mainnet.
 * @dev Overrides the behavior-neutral `_now()` seam to add a settable offset. All locker logic is inherited
 *      unchanged, so the demo faithfully reflects production behavior.
 */
contract DemoEVALocker is EVALocker {
    /// @notice Seconds added on top of real time. Advanced by the admin to simulate the future.
    uint256 public timeOffset;

    event TimeAdvanced(uint256 bySeconds, uint256 newOffset, uint256 newNow);

    constructor(
        address _eva,
        address _wbtc,
        address _coreVault,
        uint256[] memory weights,
        uint256[] memory durations,
        Curve[] memory curves,
        bool[] memory transferables
    ) EVALocker(_eva, _wbtc, _coreVault, weights, durations, curves, transferables) {}

    /// @notice Fast-forward the locker's clock by `secs` seconds (demo only).
    function advanceTime(uint256 secs) external onlyOwner {
        timeOffset += secs;
        emit TimeAdvanced(secs, timeOffset, _now());
    }

    /// @notice The locker's current (possibly fast-forwarded) time.
    function currentTime() external view returns (uint256) {
        return _now();
    }

    /// @dev Neutral demo NFT name/symbol (no real-token references on the testnet).
    function name() public pure override returns (string memory) {
        return "Demo Locked Position";
    }

    function symbol() public pure override returns (string memory) {
        return "DLOCK";
    }

    /// @inheritdoc EVALocker
    function _now() internal view override returns (uint256) {
        return block.timestamp + timeOffset;
    }
}
