// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {SetwiseRebalancingPool} from "../SetwiseRebalancingPool.sol";

/// @custom:oz-upgrades-unsafe-allow missing-initializer
contract SetwiseRebalancingPoolV2 is SetwiseRebalancingPool {
    uint256 public upgradeMarker;

    function initializeV2(uint256 marker) external reinitializer(2) onlyOwner {
        upgradeMarker = marker;
    }

    function implementationVersion() external pure returns (uint256) {
        return 2;
    }
}
