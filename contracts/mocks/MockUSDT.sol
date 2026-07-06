// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Testnet-only 18-decimal mock matching USDT on BNB Smart Chain.
contract MockUSDT is ERC20, Ownable {
    constructor(address owner_) ERC20("Mock Tether USD", "mUSDT") {
        _transferOwnership(owner_);
    }

    function mint(address recipient, uint256 amount) external onlyOwner {
        _mint(recipient, amount);
    }

    function burn(address account, uint256 amount) external onlyOwner {
        _burn(account, amount);
    }
}
