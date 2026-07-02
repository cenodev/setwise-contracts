// SPDX-License-Identifier: MIT

pragma solidity ^0.8.19;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import {IWrappedNativeToken} from "./interfaces/IWrappedNativeToken.sol";

import {SetwisePoolBase} from "./SetwisePoolBase.sol";

contract SetwisePool is SetwisePoolBase, Ownable {
    using SafeCast for uint256;
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

    function confirmUnique(address token) internal view returns (uint32 newHash, uint256 currentBalance) {
        uint256 _current = _packedBalances[token];
        currentBalance = uint256(uint224(_current));
        uint32 lastHash = uint32(_current >> 224);
        newHash = uint32(block.number + uint256(uint160(tx.origin)));
        require(newHash != lastHash, "Setwise: Failed tx uniqueness");
    }

    function makeWriteValue(uint32 newHash, uint256 newBalance) internal pure returns (uint256) {
        return (uint256(newHash) << 224) + uint256(newBalance.toUint224());
    }

    function setBalance(address token, uint256 newBalance) internal virtual {
        (uint32 newHash, ) = confirmUnique(token);
        _packedBalances[token] = makeWriteValue(newHash, newBalance);
    }

    function increaseBalance(address token, uint256 increaseAmount) internal virtual {
        (uint32 newHash, uint256 curBalance) = confirmUnique(token);
        _packedBalances[token] = makeWriteValue(newHash, curBalance + increaseAmount);
    }

    function decreaseBalance(address token, uint256 decreaseAmount) internal virtual {
        (uint32 newHash, uint256 curBalance) = confirmUnique(token);
        _packedBalances[token] = makeWriteValue(newHash, curBalance - decreaseAmount);
    }

    function recordedBalance(address token) public view virtual override returns (uint256) {
        return uint256(uint224(_packedBalances[token]));
    }

    // Can deposit raw ETH by attaching as msg.value
    function settlePortfolioDeposit(
        address investor,
        uint256[] calldata depositAmounts,
        uint256 lockDays,
        uint256 shares,
        uint256 deadline,
        Signature calldata signature
    ) public payable override tradingActive beforeDeadline(deadline) {
        if (msg.value > 0) {
            safeEthSend(WRAPPED_NATIVE_TOKEN, msg.value);
        }
        // Make sure the depositor is allowed
        require(msg.sender == investor, "Listed investor does not match msg.sender");
        bytes32 depositDigest = createDepositDigest(investor, depositAmounts, lockDays, shares, deadline);
        // Revert if it's signed by the wrong address
        verifyDigestSignature(depositDigest, signature);

        // Check deposit amounts, syncing as we go
        uint256 i = 0;
        uint256 n = depositAmounts.length;
        while (i < n) {
            uint256 allegedDeposit = depositAmounts[i];
            if (allegedDeposit > 0) {
                address _token = assetAt(i);
                uint256 currentBalance = assetBalance(_token);
                require(currentBalance - recordedBalance(_token) >= allegedDeposit, "Insufficient token deposit");
                setBalance(_token, currentBalance);
            }
            i++;
        }
        // OK now we're good
        _mintOrVesting(investor, lockDays, shares);
        emit PortfolioDeposited(investor, shares, lockDays);
    }

    function settleSingleAssetDeposit(
        address investor,
        address inputAsset,
        uint256 inputAmount,
        uint256 lockDays,
        uint256 shares,
        uint256 deadline,
        Signature calldata signature
    ) public payable override tradingActive beforeDeadline(deadline) {
        if (msg.value > 0) {
            safeEthSend(WRAPPED_NATIVE_TOKEN, msg.value);
        }
        // Make sure the depositor is allowed
        require(msg.sender == investor && isSupportedAsset(inputAsset), "Invalid input");

        // Check the signature
        bytes32 depositDigest = createSingleDepositDigest(
            investor,
            inputAsset,
            inputAmount,
            lockDays,
            shares,
            deadline
        );
        // Revert if it's signed by the wrong address
        verifyDigestSignature(depositDigest, signature);

        // Check deposit amount and sync balance
        uint256 currentBalance = assetBalance(inputAsset);
        require(currentBalance - recordedBalance(inputAsset) >= inputAmount, "Insufficient token deposit");
        // sync the balance
        setBalance(inputAsset, currentBalance);

        // OK now we're good
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
        uint256 deadline,
        Signature calldata signature
    ) external override tradingActive beforeDeadline(deadline) {
        /* CHECKS */
        require(msg.sender == investor, "investor does not match msg.sender");

        bool sendEthBack;
        if (assetAddress == NATIVE_TOKEN) {
            assetAddress = WRAPPED_NATIVE_TOKEN;
            sendEthBack = true;
        }

        bytes32 withdrawalDigest = createWithdrawalDigest(investor, sharesToBurn, assetAddress, assetAmount, deadline);
        // Reverts if it's signed by the wrong address
        verifyDigestSignature(withdrawalDigest, signature);

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

    // Don't need a separate "transmit" function here since it's already payable
    // Gas optimized - no balance checks
    // Don't need fairOutput checks since exactly inputAmount is wrapped
    function swapExactNativeForAsset(
        address outputAsset,
        uint256 inputAmount,
        uint256 outputAmount,
        uint256 deadline,
        address recipient,
        Signature calldata signature,
        bytes calldata auxiliaryData
    ) external payable virtual override tradingActive beforeDeadline(deadline) {
        /* CHECKS */
        require(isSupportedAsset(outputAsset), "Setwise: Invalid token");
        // Wrap ETH (as balance or value) as input. This will revert if insufficient balance is provided
        safeEthSend(WRAPPED_NATIVE_TOKEN, inputAmount);
        // Revert if it's signed by the wrong address
        bytes32 digest = createSwapQuoteDigest(
            WRAPPED_NATIVE_TOKEN,
            outputAsset,
            inputAmount,
            outputAmount,
            deadline,
            recipient
        );
        verifyDigestSignature(digest, signature);

        /* EFFECTS */
        increaseBalance(WRAPPED_NATIVE_TOKEN, inputAmount);
        decreaseBalance(outputAsset, outputAmount);

        /* INTERACTIONS */
        IERC20(outputAsset).safeTransfer(recipient, outputAmount);

        emit SwapExecuted(WRAPPED_NATIVE_TOKEN, outputAsset, recipient, inputAmount, outputAmount, auxiliaryData);
    }

    // Mostly copied from gas-optimized settleAssetForAssetSwap functionality
    function settleAssetForNativeSwap(
        address inputAsset,
        uint256 inputAmount,
        uint256 outputAmount,
        uint256 deadline,
        address recipient,
        Signature calldata signature,
        bytes calldata auxiliaryData
    ) external virtual override tradingActive beforeDeadline(deadline) {
        /* CHECKS */
        require(isSupportedAsset(inputAsset), "Setwise: Invalid token");
        // Revert if it's signed by the wrong address
        bytes32 digest = createSwapQuoteDigest(
            inputAsset,
            WRAPPED_NATIVE_TOKEN,
            inputAmount,
            outputAmount,
            deadline,
            recipient
        );
        verifyDigestSignature(digest, signature);

        // Check that enough input token has been transmitted
        uint256 currentInputBalance = assetBalance(inputAsset);
        uint256 actualInput = currentInputBalance - recordedBalance(inputAsset);
        uint256 fairOutput = calculateFairOutput(inputAmount, actualInput, outputAmount);

        /* EFFECTS */
        setBalance(inputAsset, currentInputBalance);
        decreaseBalance(WRAPPED_NATIVE_TOKEN, fairOutput);

        /* INTERACTIONS */
        // Unwrap and forward ETH, without sync
        IWrappedNativeToken(WRAPPED_NATIVE_TOKEN).withdraw(fairOutput);
        safeEthSend(recipient, fairOutput);

        emit SwapExecuted(inputAsset, WRAPPED_NATIVE_TOKEN, recipient, actualInput, fairOutput, auxiliaryData);
    }

    function depositSingleAsset(
        address inputAsset,
        uint256 inputAmount,
        uint256 lockDays,
        uint256 shares,
        uint256 deadline,
        Signature calldata signature
    ) external virtual override tradingActive beforeDeadline(deadline) {
        // Make sure the depositor is allowed
        require(isSupportedAsset(inputAsset), "Invalid input");

        // Will revert if msg.sender has insufficient balance
        IERC20(inputAsset).safeTransferFrom(msg.sender, address(this), inputAmount);

        // Check the signature
        bytes32 depositDigest = createSingleDepositDigest(
            msg.sender,
            inputAsset,
            inputAmount,
            lockDays,
            shares,
            deadline
        );
        // Revert if it's signed by the wrong address
        verifyDigestSignature(depositDigest, signature);

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
        uint256 deadline,
        address recipient,
        Signature calldata signature,
        bytes calldata auxiliaryData
    ) external virtual override tradingActive beforeDeadline(deadline) {
        /* CHECKS */
        require(isSupportedAsset(inputAsset), "Setwise: Invalid token");
        // Will revert if msg.sender has insufficient balance
        IERC20(inputAsset).safeTransferFrom(msg.sender, address(this), inputAmount);
        // Revert if it's signed by the wrong address
        bytes32 digest = createSwapQuoteDigest(
            inputAsset,
            WRAPPED_NATIVE_TOKEN,
            inputAmount,
            outputAmount,
            deadline,
            recipient
        );
        verifyDigestSignature(digest, signature);

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
        uint256 deadline,
        address recipient,
        Signature calldata signature,
        bytes calldata auxiliaryData
    ) external virtual override tradingActive beforeDeadline(deadline) {
        /* CHECKS */
        require(isSupportedAsset(inputAsset) && isSupportedAsset(outputAsset), "Setwise: Invalid tokens");
        // Will revert if msg.sender has insufficient balance
        IERC20(inputAsset).safeTransferFrom(msg.sender, address(this), inputAmount);
        // Revert if it's signed by the wrong address
        bytes32 digest = createSwapQuoteDigest(inputAsset, outputAsset, inputAmount, outputAmount, deadline, recipient);
        verifyDigestSignature(digest, signature);

        /* EFFECTS */
        increaseBalance(inputAsset, inputAmount);
        decreaseBalance(outputAsset, outputAmount);

        /* INTERACTIONS */
        IERC20(outputAsset).safeTransfer(recipient, outputAmount);

        emit SwapExecuted(inputAsset, outputAsset, recipient, inputAmount, outputAmount, auxiliaryData);
    }

    // Gas optimized - single token balance check for input
    // output is dead-reckoned and scaled back if necessary
    function settleAssetForAssetSwap(
        address inputAsset,
        address outputAsset,
        uint256 inputAmount,
        uint256 outputAmount,
        uint256 deadline,
        address recipient,
        Signature calldata signature,
        bytes calldata auxiliaryData
    ) public virtual override tradingActive beforeDeadline(deadline) {
        /* CHECKS */
        require(isSupportedAsset(inputAsset) && isSupportedAsset(outputAsset), "Setwise: Invalid tokens");

        {
            // Avoid stack too deep
            // Revert if it's signed by the wrong address
            bytes32 digest = createSwapQuoteDigest(
                inputAsset,
                outputAsset,
                inputAmount,
                outputAmount,
                deadline,
                recipient
            );
            verifyDigestSignature(digest, signature);
        }

        // Get fair output value
        uint256 currentInputBalance = assetBalance(inputAsset);
        uint256 actualInput = currentInputBalance - recordedBalance(inputAsset);
        uint256 fairOutput = calculateFairOutput(inputAmount, actualInput, outputAmount);

        /* EFFECTS */
        setBalance(inputAsset, currentInputBalance);
        decreaseBalance(outputAsset, fairOutput);

        /* INTERACTIONS */
        IERC20(outputAsset).safeTransfer(recipient, fairOutput);

        emit SwapExecuted(inputAsset, outputAsset, recipient, actualInput, fairOutput, auxiliaryData);
    }
}
