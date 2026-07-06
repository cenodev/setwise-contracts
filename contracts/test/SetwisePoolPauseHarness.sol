// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {SetwisePool} from "../SetwisePool.sol";

/// @custom:oz-upgrades-unsafe-allow missing-initializer
contract SetwisePoolPauseHarness is SetwisePool {
    bool private _paused;

    function setPaused(bool paused) external {
        _paused = paused;
    }

    function isTradingPaused() public view override returns (bool) {
        return _paused;
    }

    function exposedSetwisePoolInitializer(
        address quoteSigner,
        address wrappedNativeToken,
        address[] memory supportedAssets
    ) external {
        __SetwisePool_init(quoteSigner, wrappedNativeToken, supportedAssets);
    }

    function exposedSetwisePoolBaseInitializer(
        address quoteSigner,
        address wrappedNativeToken,
        address[] memory supportedAssets
    ) external {
        __SetwisePoolBase_init(quoteSigner, wrappedNativeToken, supportedAssets);
    }
}
