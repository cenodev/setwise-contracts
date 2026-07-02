// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {SetwisePool} from "../SetwisePool.sol";

contract SetwisePoolPauseHarness is SetwisePool {
    bool private _paused;

    constructor(
        address quoteSigner,
        address wrappedNativeToken,
        address[] memory supportedAssets
    ) SetwisePool(quoteSigner, wrappedNativeToken, supportedAssets) {}

    function setPaused(bool paused) external {
        _paused = paused;
    }

    function isTradingPaused() public view override returns (bool) {
        return _paused;
    }
}
