// SPDX-License-Identifier: MIT

/*
//============================================================================\
//  CENO_LABS::SETWISE_PROTOCOL                                      [ONLINE]  //
//                                                                            //
//     ______ _______   ______     __    ___    ____  _____                   //
//    / ____// ____/ | / / __ \   / /   /   |  / __ )/ ___/                  //
//   / /    / __/ /  |/ / / / /  / /   / /| | / __  |\__ \                   //
//  / /___ / /___/ /|  / /_/ /  / /___/ ___ |/ /_/ /___/ /                  //
//  \____//_____/_/ |_/\____/  /_____/_/  |_/_____//____/                   //
//                                  Ceno.dev                                  //
\============================================================================//
*/

pragma solidity ^0.8.19;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import {IWrappedNativeToken} from "./interfaces/IWrappedNativeToken.sol";

import {SetwisePoolBase} from "./SetwisePoolBase.sol";

contract SetwisePool is SetwisePoolBase, Ownable {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

    // Pausing blocks swaps, deposits, and single-asset withdrawals.
    error TradingPaused();

    modifier tradingActive() {
        if (isTradingPaused()) {
            revert TradingPaused();
        }
        _;
    }

    modifier beforeDeadline(uint256 deadline) {
        require(block.timestamp <= deadline, "Setwise: Expired");
        _;
    }

    constructor(
        address quoteSigner,
        address wrappedNativeToken,
        address[] memory supportedAssets
    ) SetwisePoolBase(quoteSigner, wrappedNativeToken, supportedAssets) {}

    function isTradingPaused() public view virtual returns (bool) {
        return false;
    }

    function addAsset(address token) external onlyOwner {
        assetSet.add(token);
        _sync(token);
    }

    function assetBalance(address token) internal view returns (uint256) {
        (bool success, bytes memory data) = token.staticcall(
            abi.encodeWithSelector(IERC20.balanceOf.selector, address(this))
        );
        require(success && data.length >= 32);
        return abi.decode(data, (uint256));
    }

    function _sync(address token) internal virtual override {
        setBalance(token, assetBalance(token));
    }

    function setBalance(address token, uint256 newBalance) internal virtual {
        _recordedBalances[token] = newBalance;
    }

    function increaseBalance(address token, uint256 increaseAmount) internal virtual {
        _recordedBalances[token] += increaseAmount;
    }

    function decreaseBalance(address token, uint256 decreaseAmount) internal virtual {
        _recordedBalances[token] -= decreaseAmount;
    }

    function depositPortfolio(
        uint256[] calldata depositAmounts,
        uint256 lockDays,
        uint256 shares,
        bytes32 quoteId,
        uint256 deadline,
        bytes calldata signature
    ) external override nonReentrant tradingActive beforeDeadline(deadline) {
        bytes32 depositDigest = createDepositDigest(msg.sender, depositAmounts, lockDays, shares, quoteId, deadline);
        verifyAndConsumeQuote(quoteId, depositDigest, signature);

        uint256 n = depositAmounts.length;
        for (uint256 i = 0; i < n; i++) {
            uint256 transferAmount = depositAmounts[i];
            if (transferAmount > 0) {
                IERC20(assetAt(i)).safeTransferFrom(msg.sender, address(this), transferAmount);
            }
        }

        _completePortfolioDeposit(msg.sender, depositAmounts, lockDays, shares);
    }

    function _completePortfolioDeposit(
        address investor,
        uint256[] calldata depositAmounts,
        uint256 lockDays,
        uint256 shares
    ) internal {
        uint256 n = depositAmounts.length;
        for (uint256 i = 0; i < n; i++) {
            uint256 depositAmount = depositAmounts[i];
            if (depositAmount > 0) {
                address asset = assetAt(i);
                uint256 currentBalance = assetBalance(asset);
                require(currentBalance - recordedBalance(asset) >= depositAmount, "Insufficient token deposit");
                setBalance(asset, currentBalance);
            }
        }

        _mintOrVesting(investor, lockDays, shares);
        emit PortfolioDeposited(investor, shares, lockDays);
    }

    /* WITHDRAWAL FUNCTIONALITY */

    /* Single asset withdrawal functionality */

    function withdrawSingleAsset(
        address investor,
        uint256 sharesToBurn,
        address assetAddress,
        uint256 assetAmount,
        bytes32 quoteId,
        uint256 deadline,
        bytes calldata signature
    ) external override nonReentrant tradingActive beforeDeadline(deadline) {
        /* CHECKS */
        require(msg.sender == investor, "investor does not match msg.sender");

        bool sendEthBack;
        if (assetAddress == NATIVE_TOKEN) {
            assetAddress = WRAPPED_NATIVE_TOKEN;
            sendEthBack = true;
        }

        bytes32 withdrawalDigest = createWithdrawalDigest(
            investor,
            sharesToBurn,
            assetAddress,
            assetAmount,
            quoteId,
            deadline
        );
        verifyAndConsumeQuote(quoteId, withdrawalDigest, signature);

        /* EFFECTS */
        // Reverts if pool token balance is insufficient
        _burn(msg.sender, sharesToBurn);

        // Reverts if the pool's balance of the token is insufficient
        decreaseBalance(assetAddress, assetAmount);

        /* INTERACTIONS */
        if (sendEthBack) {
            IWrappedNativeToken(WRAPPED_NATIVE_TOKEN).withdraw(assetAmount);
            safeEthSend(msg.sender, assetAmount);
        } else {
            IERC20(assetAddress).safeTransfer(msg.sender, assetAmount);
        }

        emit SingleAssetWithdrawn(investor, sharesToBurn, assetAddress, assetAmount);
    }

    /* SWAP Functionality */

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
    ) external payable virtual override nonReentrant tradingActive beforeDeadline(deadline) {
        /* CHECKS */
        require(isSupportedAsset(outputAsset), "Setwise: Invalid token");
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

        /* EFFECTS */
        increaseBalance(WRAPPED_NATIVE_TOKEN, inputAmount);
        decreaseBalance(outputAsset, outputAmount);

        /* INTERACTIONS */
        IERC20(outputAsset).safeTransfer(recipient, outputAmount);

        emit SwapExecuted(WRAPPED_NATIVE_TOKEN, outputAsset, recipient, inputAmount, outputAmount, auxiliaryData);
    }

    function depositSingleAsset(
        address inputAsset,
        uint256 inputAmount,
        uint256 lockDays,
        uint256 shares,
        bytes32 quoteId,
        uint256 deadline,
        bytes calldata signature
    ) external virtual override nonReentrant tradingActive beforeDeadline(deadline) {
        // Make sure the depositor is allowed
        require(isSupportedAsset(inputAsset), "Invalid input");

        bytes32 depositDigest = createSingleDepositDigest(
            msg.sender,
            inputAsset,
            inputAmount,
            lockDays,
            shares,
            quoteId,
            deadline
        );
        verifyAndConsumeQuote(quoteId, depositDigest, signature);

        IERC20(inputAsset).safeTransferFrom(msg.sender, address(this), inputAmount);

        // sync the deposited asset
        increaseBalance(inputAsset, inputAmount);

        // OK now we're good
        _mintOrVesting(msg.sender, lockDays, shares);
        emit PortfolioDeposited(msg.sender, shares, lockDays);
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
    ) external virtual override nonReentrant tradingActive beforeDeadline(deadline) {
        /* CHECKS */
        require(isSupportedAsset(inputAsset), "Setwise: Invalid token");
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

        /* EFFECTS */
        increaseBalance(inputAsset, inputAmount);
        decreaseBalance(WRAPPED_NATIVE_TOKEN, outputAmount);

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
    ) external virtual override nonReentrant tradingActive beforeDeadline(deadline) {
        /* CHECKS */
        require(isSupportedAsset(inputAsset) && isSupportedAsset(outputAsset), "Setwise: Invalid tokens");
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

        /* EFFECTS */
        increaseBalance(inputAsset, inputAmount);
        decreaseBalance(outputAsset, outputAmount);

        /* INTERACTIONS */
        IERC20(outputAsset).safeTransfer(recipient, outputAmount);

        emit SwapExecuted(inputAsset, outputAsset, recipient, inputAmount, outputAmount, auxiliaryData);
    }
}
