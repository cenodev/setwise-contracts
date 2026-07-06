// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IMockWrappedNative {
    function deposit() external payable;

    function withdraw(uint256 amount) external;
}

contract MockWrappedNativeRejector {
    function depositAndWithdraw(address wrappedToken) external payable {
        IMockWrappedNative(wrappedToken).deposit{value: msg.value}();
        IMockWrappedNative(wrappedToken).withdraw(msg.value);
    }

    receive() external payable {
        revert("native rejected");
    }
}
