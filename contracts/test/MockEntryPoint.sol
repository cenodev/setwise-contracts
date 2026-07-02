// SPDX-License-Identifier: MIT

pragma solidity ^0.8.19;

import {MockSmartAccount} from "./MockSmartAccount.sol";

contract MockEntryPoint {
    struct Operation {
        address account;
        address target;
        uint256 value;
        bytes data;
    }

    function handleOps(Operation[] calldata operations) external {
        uint256 length = operations.length;
        for (uint256 i = 0; i < length; i++) {
            Operation calldata operation = operations[i];
            MockSmartAccount(payable(operation.account)).execute(operation.target, operation.value, operation.data);
        }
    }
}
