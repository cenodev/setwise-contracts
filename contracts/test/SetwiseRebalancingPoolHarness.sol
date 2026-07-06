// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {SetwiseRebalancingPool} from "../SetwiseRebalancingPool.sol";

/// @custom:oz-upgrades-unsafe-allow missing-initializer
contract SetwiseRebalancingPoolHarness is SetwiseRebalancingPool {
    function exposedCheckInvariant(
        uint256 qX,
        uint256 qY,
        uint256 offchainX,
        uint256 offchainY,
        uint256 maximumX,
        uint256 minimumY
    ) external pure returns (bool) {
        return checkInvariant(qX, qY, offchainX, offchainY, maximumX, minimumY);
    }

    function exposedUnpackGoodUntil(
        uint256 packedGoodUntil
    ) external pure returns (uint256 offchainX, uint256 offchainY, uint256 maximumX, uint256 minimumY) {
        return unpackGoodUntil(packedGoodUntil);
    }

    function exposedCreateVestingDeposit(address investor, uint256 lockDays, uint256 shares) external {
        _createVestingDeposit(investor, lockDays, shares);
    }
}
