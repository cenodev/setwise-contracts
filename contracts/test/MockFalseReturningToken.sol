// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockFalseReturningToken is ERC20 {
    constructor() ERC20("False Returning Token", "FALSE") {}

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }

    function transfer(address, uint256) public pure override returns (bool) {
        return false;
    }
}
