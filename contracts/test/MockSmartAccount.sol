// SPDX-License-Identifier: MIT

pragma solidity ^0.8.19;

contract MockSmartAccount {
    address public immutable ENTRY_POINT;
    address public immutable OWNER;

    error ExecutionFailed(bytes result);
    error Unauthorized();

    constructor(address entryPoint_, address owner_) {
        ENTRY_POINT = entryPoint_;
        OWNER = owner_;
    }

    receive() external payable {}

    function execute(address target, uint256 value, bytes calldata data) external returns (bytes memory result) {
        if (msg.sender != OWNER && msg.sender != ENTRY_POINT) {
            revert Unauthorized();
        }

        bool success;
        (success, result) = target.call{value: value}(data);
        if (!success) {
            revert ExecutionFailed(result);
        }
    }
}
