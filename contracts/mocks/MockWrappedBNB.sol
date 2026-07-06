// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Testnet-only wrapped native token used by Setwise deployments.
contract MockWrappedBNB is ERC20 {
    constructor() ERC20("Mock Wrapped BNB", "mWBNB") {}

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "native transfer failed");
    }
}
