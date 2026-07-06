// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IScaledUIAmount} from "../interfaces/IScaledUIAmount.sol";

/// @notice Testnet-only BEP-20 mock for Binance-style tokenized stocks.
/// @dev Raw ERC-20 balances never rebase. The BEP-677/EIP-8056 multiplier is
///      exposed separately for scaled-UI-aware clients.
contract MockBStock is ERC20, Ownable, IERC165, IScaledUIAmount {
    uint256 public constant MULTIPLIER_SCALE = 1e18;

    uint256 public override uiMultiplier = MULTIPLIER_SCALE;

    error InvalidMultiplier();

    constructor(string memory name_, string memory symbol_, address owner_) ERC20(name_, symbol_) {
        _transferOwnership(owner_);
    }

    function mint(address recipient, uint256 amount) external onlyOwner {
        _mint(recipient, amount);
    }

    function burn(address account, uint256 amount) external onlyOwner {
        _burn(account, amount);
    }

    function updateUIMultiplier(uint256 newMultiplier) external onlyOwner {
        if (newMultiplier == 0) {
            revert InvalidMultiplier();
        }
        uint256 oldMultiplier = uiMultiplier;
        uiMultiplier = newMultiplier;
        emit UIMultiplierUpdated(oldMultiplier, newMultiplier, block.timestamp);
    }

    function scaledBalanceOf(address account) external view returns (uint256) {
        return Math.mulDiv(balanceOf(account), uiMultiplier, MULTIPLIER_SCALE);
    }

    function scaledTotalSupply() external view returns (uint256) {
        return Math.mulDiv(totalSupply(), uiMultiplier, MULTIPLIER_SCALE);
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IERC165).interfaceId || interfaceId == type(IScaledUIAmount).interfaceId;
    }
}
