// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title DemoMintableToken
 * @notice TESTNET/DEMO ONLY. An ERC-20 with an owner-only mint and configurable decimals so it can stand
 *         in for EVA (18) or WBTC (8). Burnable, so it works as the EVA token for the core vault's
 *         burnFrom on early exit. NEVER deploy to mainnet.
 * @dev Mint is restricted to the owner (the deployer) so the testnet replica keeps production-like
 *      supply / backing ratios; test balances are handed out by the deployer, not self-served.
 */
contract DemoMintableToken is ERC20, ERC20Burnable, Ownable {
    uint8 private immutable _dec;

    constructor(string memory name_, string memory symbol_, uint8 decimals_)
        ERC20(name_, symbol_)
        Ownable(msg.sender)
    {
        _dec = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    /// @notice Owner-only faucet — mint test tokens to any address.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
