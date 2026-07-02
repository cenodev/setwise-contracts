// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

contract MockRejectNative {
    receive() external payable {
        revert("native rejected");
    }
}
