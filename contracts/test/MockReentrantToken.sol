// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockReentrantToken is ERC20 {
    address public target;
    bytes public callbackData;
    bool public callbackEnabled;
    bool private _insideCallback;

    constructor(string memory symbol_) ERC20("Reentrant Token", symbol_) {}

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }

    function configureCallback(address target_, bytes calldata callbackData_) external {
        target = target_;
        callbackData = callbackData_;
        callbackEnabled = true;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        if (callbackEnabled && !_insideCallback) {
            _insideCallback = true;
            // solhint-disable-next-line avoid-low-level-calls
            (bool success, ) = target.call(callbackData);
            require(!success, "reentrant call unexpectedly succeeded");
            _insideCallback = false;
        }
        super._transfer(from, to, amount);
    }
}
