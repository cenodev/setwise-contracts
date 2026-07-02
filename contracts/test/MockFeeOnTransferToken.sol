// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockFeeOnTransferToken is ERC20 {
    constructor() ERC20("Fee Token", "FEE") {}

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        _burn(from, 1);
        super._transfer(from, to, amount - 1);
    }
}
