// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/**
 * @title DemoMintableToken
 * @notice TESTNET/DEMO ONLY. An ERC-20 with a public faucet so anyone can mint test tokens to try the
 *         system, and configurable decimals so it can stand in for EVA (18) or WBTC (8). Burnable, so it
 *         works as the EVA token for the core vault's burnFrom on early exit. NEVER deploy to mainnet.
 */
contract DemoMintableToken is ERC20, ERC20Burnable {
    uint8 private immutable _dec;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _dec = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    /// @notice Public faucet — mint test tokens to any address.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
