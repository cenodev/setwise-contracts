// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/// @notice Rate-limited faucet for pre-funded Setwise mock assets.
/// @dev TESTNET ONLY. This contract has no mint authority and must never be used
///      as a source of assets with economic value.
contract SetwiseMockTokenFaucet is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct AssetConfiguration {
        IERC20 token;
        uint256 claimAmount;
    }

    // solhint-disable-next-line immutable-vars-naming
    uint256 public immutable cooldown;
    bool public paused;
    mapping(address claimant => uint256 eligibleAt) public nextEligibleAt;

    AssetConfiguration[] private _assets;

    error AlreadyPaused();
    error AlreadyUnpaused();
    error CooldownActive(uint256 nextEligibleTime);
    error DuplicateToken(address token);
    error EmptyConfiguration();
    error FaucetPaused();
    error InsufficientInventory(address token, uint256 required, uint256 available);
    error InvalidConfigurationLength();
    error InvalidCooldown();
    error InvalidToken(address token);
    error InvalidRecipient();
    error UnknownToken(address token);
    error ZeroClaimAmount(address token);

    event AssetConfigurationUpdated(address[] tokens, uint256[] claimAmounts);
    event ClaimAmountUpdated(address indexed token, uint256 previousAmount, uint256 newAmount);
    event Claimed(address indexed claimant, uint256 nextEligibleTime);
    event FaucetPausedBy(address indexed account);
    event FaucetUnpausedBy(address indexed account);
    event InventoryRecovered(address indexed token, address indexed recipient, uint256 amount);

    constructor(address[] memory tokens, uint256[] memory claimAmounts, uint256 cooldownSeconds, address owner_) {
        if (cooldownSeconds == 0) revert InvalidCooldown();
        if (owner_ == address(0)) revert InvalidRecipient();

        cooldown = cooldownSeconds;
        _setConfiguration(tokens, claimAmounts);
        _transferOwnership(owner_);
    }

    function assetCount() external view returns (uint256) {
        return _assets.length;
    }

    function assetAt(uint256 index) external view returns (address token, uint256 claimAmount, uint256 inventory) {
        AssetConfiguration storage asset = _assets[index];
        token = address(asset.token);
        claimAmount = asset.claimAmount;
        inventory = asset.token.balanceOf(address(this));
    }

    function claim() external nonReentrant {
        if (paused) revert FaucetPaused();

        uint256 eligibleAt = nextEligibleAt[msg.sender];
        if (block.timestamp < eligibleAt) revert CooldownActive(eligibleAt);

        uint256 count = _assets.length;
        for (uint256 i = 0; i < count; ++i) {
            AssetConfiguration storage asset = _assets[i];
            uint256 available = asset.token.balanceOf(address(this));
            if (available < asset.claimAmount) {
                revert InsufficientInventory(address(asset.token), asset.claimAmount, available);
            }
        }

        uint256 nextEligibleTime = block.timestamp + cooldown;
        nextEligibleAt[msg.sender] = nextEligibleTime;

        for (uint256 i = 0; i < count; ++i) {
            AssetConfiguration storage asset = _assets[i];
            asset.token.safeTransfer(msg.sender, asset.claimAmount);
        }

        emit Claimed(msg.sender, nextEligibleTime);
    }

    function setConfiguration(address[] calldata tokens, uint256[] calldata claimAmounts) external onlyOwner {
        _setConfiguration(tokens, claimAmounts);
    }

    function setClaimAmount(address token, uint256 newAmount) external onlyOwner {
        if (newAmount == 0) revert ZeroClaimAmount(token);

        uint256 count = _assets.length;
        for (uint256 i = 0; i < count; ++i) {
            AssetConfiguration storage asset = _assets[i];
            if (address(asset.token) == token) {
                uint256 previousAmount = asset.claimAmount;
                asset.claimAmount = newAmount;
                emit ClaimAmountUpdated(token, previousAmount, newAmount);
                return;
            }
        }
        revert UnknownToken(token);
    }

    function pause() external onlyOwner {
        if (paused) revert AlreadyPaused();
        paused = true;
        emit FaucetPausedBy(msg.sender);
    }

    function unpause() external onlyOwner {
        if (!paused) revert AlreadyUnpaused();
        paused = false;
        emit FaucetUnpausedBy(msg.sender);
    }

    function recoverInventory(address token, address recipient, uint256 amount) external onlyOwner {
        if (token == address(0)) revert InvalidToken(token);
        if (recipient == address(0)) revert InvalidRecipient();
        IERC20(token).safeTransfer(recipient, amount);
        emit InventoryRecovered(token, recipient, amount);
    }

    function _setConfiguration(address[] memory tokens, uint256[] memory claimAmounts) private {
        uint256 count = tokens.length;
        if (count == 0) revert EmptyConfiguration();
        if (count != claimAmounts.length) revert InvalidConfigurationLength();

        delete _assets;
        for (uint256 i = 0; i < count; ++i) {
            address token = tokens[i];
            if (token == address(0)) revert InvalidToken(token);
            if (claimAmounts[i] == 0) revert ZeroClaimAmount(token);
            for (uint256 j = 0; j < i; ++j) {
                if (tokens[j] == token) revert DuplicateToken(token);
            }
            _assets.push(AssetConfiguration({token: IERC20(token), claimAmount: claimAmounts[i]}));
        }

        emit AssetConfigurationUpdated(tokens, claimAmounts);
    }
}
