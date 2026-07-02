// SPDX-License-Identifier: MIT

pragma solidity ^0.8.19;

interface IWrappedNativeToken {
    function withdraw(uint256 amount) external;
}
