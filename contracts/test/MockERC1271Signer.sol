// SPDX-License-Identifier: MIT

pragma solidity ^0.8.19;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract MockERC1271Signer is IERC1271 {
    address public immutable OWNER;

    constructor(address owner_) {
        OWNER = owner_;
    }

    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        return ECDSA.recover(hash, signature) == OWNER ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }
}
