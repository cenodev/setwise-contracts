// SPDX-License-Identifier: MIT

pragma solidity ^0.8.19;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IWrappedNativeToken} from "./interfaces/IWrappedNativeToken.sol";

import {SetwisePool} from "./SetwisePool.sol";

contract SetwiseRebalancingPool is SetwisePool, ERC20Permit {
    using SafeERC20 for IERC20;

    uint256 internal constant ONE_IN_SIX_DECIMALS = 1e6;

    bool private _tradingPaused;
    address public guardian;

    error RebalancingInvariantViolation();

    event GuardianChanged(address indexed newAddress);

    constructor(
        address quoteSigner,
        address wrappedNativeToken,
        address[] memory supportedAssets
    ) SetwisePool(quoteSigner, wrappedNativeToken, supportedAssets) ERC20Permit("Setwise Portfolio Share") {}

    /*
    Guardian emergency functionality.

    owner can set an address that has the ability to halt trade.
    Only proportional withdrawals are allowed if trade is halted.
  */
    function setGuardian(address newGuardian) external onlyOwner {
        guardian = newGuardian;
        emit GuardianChanged(newGuardian);
    }

    function isTradingPaused() public view override returns (bool) {
        return _tradingPaused;
    }

    function pauseTrading() external {
        if (msg.sender == guardian) {
            _tradingPaused = true;
        }
    }

    function resumeTrading() external {
        if (msg.sender == guardian) {
            _tradingPaused = false;
        }
    }

    /* SWAP Functionality */

    // checks timestamp
    // return value: qX, qY
    function unpackAndCheckInvariant(
        address inputAsset,
        address outputAsset,
        uint256 packedGoodUntil
    ) internal view beforeDeadline(uint256(uint32(packedGoodUntil))) returns (uint256 qX, uint256 qY) {
        (uint256 offchainX, uint256 offchainY, uint256 maximumX, uint256 minimumY) = unpackGoodUntil(packedGoodUntil);
        qX = recordedBalance(inputAsset);
        qY = recordedBalance(outputAsset);

        if (!checkInvariant(qX, qY, offchainX, offchainY, maximumX, minimumY)) {
            revert RebalancingInvariantViolation();
        }
    }

    function checkInvariant(
        uint256 qX,
        uint256 qY,
        uint256 offchainX,
        uint256 offchainY,
        uint256 maximumX,
        uint256 minimumY
    ) internal pure returns (bool) {
        /*
      Nine regions in quantity space:
      qX: -- A -- offchainX --- B --- maximumX -- C --
      qY: -- 1 -- minimumY --- 2 ---- offchainY -- 3 --

      C1 -> fail (too much qX AND too little qY)
      C2,C3 -> fail (too much qX)
      A1,B1 -> fail (too little qY)
      A3 -> succeed (no or exclusively beneficial change from offchain state)
      A2,B3 -> succeed (allowable within slippage)
      B2 -> complex linear case
    */

        if (qY >= offchainY && qX <= offchainX) {
            // Region A3
            return true;
        } else if (qY < minimumY || qX > maximumX) {
            // Regions C1, C2, C3, A1, B1
            return false;
        } else {
            if (qY >= offchainY) {
                // Region B3
                return true;
            } else if (qX <= offchainX) {
                // Region A2
                return true;
            } else {
                // Region B2, complex linear case
                // qY is somewhere between minimumY and offchainY
                // qX is somewhere between offchainX and maximumX

                // between minimumY and offchainY, we go up maximumX - offchainX
                uint256 targetDiffX = ((ONE_IN_SIX_DECIMALS * (qY - minimumY) * (maximumX - offchainX)) /
                    (offchainY - minimumY)) / ONE_IN_SIX_DECIMALS;
                return qX <= (offchainX + targetDiffX);
            }
        }
    }

    function unpackGoodUntil(
        uint256 packedGoodUntil
    ) internal pure returns (uint256 offchainX, uint256 offchainY, uint256 maximumX, uint256 minimumY) {
        /*
         * Offchain balance input Token - uint96
         * Offchain balance output Token - uint96
         * Input multiplier - uint16
         * Output multiplier - uint16
         * Current good until value - uint32 - can be taken as uint256(uint32(packedGoodUntil))
         */
        // deadline = uint256(uint32(packedGoodUntil));
        offchainX = uint256(packedGoodUntil >> 160);
        offchainY = uint256(uint96(packedGoodUntil >> 64));
        uint256 rawMultX = uint256(uint16(packedGoodUntil >> 48));
        uint256 rawMultY = uint256(uint16(packedGoodUntil >> 32));

        maximumX = ((ONE_IN_SIX_DECIMALS + rawMultX) * offchainX) / ONE_IN_SIX_DECIMALS;
        minimumY = ((ONE_IN_SIX_DECIMALS - rawMultY) * offchainY) / ONE_IN_SIX_DECIMALS;
    }

    // Gas optimized - no balance checks
    // Don't need fairOutput checks since exactly inputAmount is wrapped
    function swapExactNativeForAsset(
        address outputAsset,
        uint256 inputAmount,
        uint256 outputAmount,
        bytes32 quoteId,
        uint256 deadline,
        address recipient,
        bytes calldata signature,
        bytes calldata auxiliaryData
    ) external payable override nonReentrant tradingActive {
        /* CHECKS */
        if (msg.value != inputAmount) {
            revert InvalidNativeAmount(inputAmount, msg.value);
        }
        {
            bytes32 digest = createSwapQuoteDigest(
                msg.sender,
                WRAPPED_NATIVE_TOKEN,
                outputAsset,
                inputAmount,
                outputAmount,
                quoteId,
                deadline,
                recipient
            );
            verifyAndConsumeQuote(quoteId, digest, signature);
        }
        safeEthSend(WRAPPED_NATIVE_TOKEN, inputAmount);

        (uint256 qX, uint256 qY) = unpackAndCheckInvariant(WRAPPED_NATIVE_TOKEN, outputAsset, deadline);

        /* EFFECTS */
        setBalance(WRAPPED_NATIVE_TOKEN, qX + inputAmount);
        setBalance(outputAsset, qY - outputAmount);

        /* INTERACTIONS */
        IERC20(outputAsset).safeTransfer(recipient, outputAmount);

        emit SwapExecuted(WRAPPED_NATIVE_TOKEN, outputAsset, recipient, inputAmount, outputAmount, auxiliaryData);
    }

    // Gas optimized, no balance checks
    // No need to check fairOutput since the inputAsset pull works
    function swapExactAssetForNative(
        address inputAsset,
        uint256 inputAmount,
        uint256 outputAmount,
        bytes32 quoteId,
        uint256 deadline,
        address recipient,
        bytes calldata signature,
        bytes calldata auxiliaryData
    ) external override nonReentrant tradingActive {
        /* CHECKS */
        {
            bytes32 digest = createSwapQuoteDigest(
                msg.sender,
                inputAsset,
                WRAPPED_NATIVE_TOKEN,
                inputAmount,
                outputAmount,
                quoteId,
                deadline,
                recipient
            );
            verifyAndConsumeQuote(quoteId, digest, signature);
        }
        IERC20(inputAsset).safeTransferFrom(msg.sender, address(this), inputAmount);

        (uint256 qX, uint256 qY) = unpackAndCheckInvariant(inputAsset, WRAPPED_NATIVE_TOKEN, deadline);

        /* EFFECTS */
        setBalance(inputAsset, qX + inputAmount);
        setBalance(WRAPPED_NATIVE_TOKEN, qY - outputAmount);

        /* INTERACTIONS */
        // Unwrap and forward ETH, we've already updated the balance
        IWrappedNativeToken(WRAPPED_NATIVE_TOKEN).withdraw(outputAmount);
        safeEthSend(recipient, outputAmount);

        emit SwapExecuted(inputAsset, WRAPPED_NATIVE_TOKEN, recipient, inputAmount, outputAmount, auxiliaryData);
    }

    // all-in-one transfer from msg.sender to recipient.
    // Gas optimized - never checks balances
    // No need to check fairOutput since the inputAsset pull works
    function swapExactAssetForAsset(
        address inputAsset,
        address outputAsset,
        uint256 inputAmount,
        uint256 outputAmount,
        bytes32 quoteId,
        uint256 deadline,
        address recipient,
        bytes calldata signature,
        bytes calldata auxiliaryData
    ) external override nonReentrant tradingActive {
        /* CHECKS */
        {
            bytes32 digest = createSwapQuoteDigest(
                msg.sender,
                inputAsset,
                outputAsset,
                inputAmount,
                outputAmount,
                quoteId,
                deadline,
                recipient
            );
            verifyAndConsumeQuote(quoteId, digest, signature);
        }
        IERC20(inputAsset).safeTransferFrom(msg.sender, address(this), inputAmount);

        (uint256 qX, uint256 qY) = unpackAndCheckInvariant(inputAsset, outputAsset, deadline);

        /* EFFECTS */
        setBalance(inputAsset, qX + inputAmount);
        setBalance(outputAsset, qY - outputAmount);

        /* INTERACTIONS */
        IERC20(outputAsset).safeTransfer(recipient, outputAmount);

        emit SwapExecuted(inputAsset, outputAsset, recipient, inputAmount, outputAmount, auxiliaryData);
    }
}
