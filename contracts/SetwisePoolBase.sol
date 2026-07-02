// SPDX-License-Identifier: MIT

pragma solidity ^0.8.19;

import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

abstract contract SetwisePoolBase is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

    struct Signature {
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    struct LockedDeposit {
        uint256 lockedUntil;
        uint256 shareAmount;
    }

    uint256 internal constant ONE_IN_TEN_DECIMALS = 1e10;
    // Allow for inputs up to 0.5% more than quoted values to have scaled output.
    // Inputs higher than this value just get 0.5% more.
    uint256 internal constant MAX_ALLOWED_OVER_TEN_DECIMALS = ONE_IN_TEN_DECIMALS + 50 * 1e6;

    // Signer is passed in on construction, hence "immutable"
    address public immutable QUOTE_SIGNER;
    address public immutable WRAPPED_NATIVE_TOKEN;
    // Constant values for EIP-712 signing
    bytes32 internal immutable QUOTE_DOMAIN_SEPARATOR;
    string internal constant VERSION = "1.0.0";
    string internal constant NAME = "SetwisePool";

    address internal constant NATIVE_TOKEN = address(0);

    bytes32 internal constant EIP712DOMAIN_TYPEHASH =
        keccak256(
            abi.encodePacked("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
        );

    bytes32 internal constant SWAP_QUOTE_TYPEHASH =
        keccak256(
            abi.encodePacked(
                "SwapQuote(address inputAsset,address outputAsset,uint256 inputAmount,uint256 outputAmount,uint256 deadline,address recipient)"
            )
        );

    bytes32 internal constant PORTFOLIO_DEPOSIT_TYPEHASH =
        keccak256(
            abi.encodePacked(
                "PortfolioDeposit(address investor,uint256[] depositAmounts,uint256 lockDays,uint256 shares,uint256 deadline)"
            )
        );

    bytes32 internal constant SINGLE_ASSET_DEPOSIT_TYPEHASH =
        keccak256(
            abi.encodePacked(
                "SingleAssetDeposit(address investor,address asset,uint256 amount,uint256 lockDays,uint256 shares,uint256 deadline)"
            )
        );

    bytes32 internal constant SINGLE_ASSET_WITHDRAWAL_TYPEHASH =
        keccak256(
            abi.encodePacked(
                "SingleAssetWithdrawal(address investor,uint256 sharesToBurn,address asset,uint256 assetAmount,uint256 deadline)"
            )
        );

    // Assets
    // Recorded balances support transfer-then-settle execution.
    mapping(address asset => uint256 packedBalance) internal _packedBalances;
    EnumerableSet.AddressSet internal assetSet;

    // Allows lookup
    mapping(address investor => LockedDeposit deposit) public lockedDeposits;

    // Events
    event SwapExecuted(
        address indexed inputAsset,
        address indexed outputAsset,
        address indexed recipient,
        uint256 inAmount,
        uint256 outAmount,
        bytes auxiliaryData
    );

    event PortfolioDeposited(address indexed depositor, uint256 shares, uint256 lockDays);

    event PortfolioWithdrawn(address indexed withdrawer, uint256 shares, uint256 fractionOfPool);

    event SingleAssetWithdrawn(
        address indexed withdrawer,
        uint256 shares,
        address indexed assetAddress,
        uint256 assetAmount
    );

    error InvalidSignature();

    function tokenName() internal pure virtual returns (string memory) {
        return "Setwise Portfolio Share";
    }

    function tokenSymbol() internal pure virtual returns (string memory) {
        return "SETWISE";
    }

    // Take in the designated signer address and the token list
    constructor(
        address quoteSigner,
        address wrappedNativeToken,
        address[] memory supportedAssets
    ) ERC20(tokenName(), tokenSymbol()) {
        QUOTE_SIGNER = quoteSigner;
        uint256 i;
        uint256 n = supportedAssets.length;
        while (i < n) {
            assetSet.add(supportedAssets[i]);
            i++;
        }
        QUOTE_DOMAIN_SEPARATOR = createDomainSeparator(NAME, VERSION, address(this));
        WRAPPED_NATIVE_TOKEN = wrappedNativeToken;
    }

    // Allows the receipt of ETH directly
    receive() external payable {}

    function safeEthSend(address recipient, uint256 howMuch) internal {
        (bool success, ) = payable(recipient).call{value: howMuch}("");
        require(success, "Call with value failed");
    }

    /* TOKEN AND ASSET FUNCTIONS */
    function assetCount() public view returns (uint256) {
        return assetSet.length();
    }

    function assetAt(uint256 i) public view returns (address) {
        return assetSet.at(i);
    }

    function isSupportedAsset(address token) public view returns (bool) {
        return assetSet.contains(token);
    }

    function quoteDomainSeparator() external view returns (bytes32) {
        return QUOTE_DOMAIN_SEPARATOR;
    }

    function _sync(address token) internal virtual;

    // The packed balance implementation overrides this to remove its uniqueness hash.
    function recordedBalance(address token) public view virtual returns (uint256) {
        return _packedBalances[token];
    }

    function portfolioState() external view returns (uint256[] memory, address[] memory, uint256) {
        uint256 n = assetCount();
        uint256[] memory balances = new uint256[](n);
        address[] memory tokens = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            address token = assetAt(i);
            balances[i] = recordedBalance(token);
            tokens[i] = token;
        }

        return (balances, tokens, totalSupply());
    }

    // nonReentrant asset transfer
    function _transferAsset(address token, address recipient, uint256 amount) internal nonReentrant {
        IERC20(token).safeTransfer(recipient, amount);
        // We never want to transfer an asset without sync'ing
        _sync(token);
    }

    function calculateFairOutput(
        uint256 statedInput,
        uint256 actualInput,
        uint256 statedOutput
    ) internal pure returns (uint256) {
        if (actualInput == statedInput) {
            return statedOutput;
        } else {
            uint256 theFraction = (ONE_IN_TEN_DECIMALS * actualInput) / statedInput;
            if (theFraction >= MAX_ALLOWED_OVER_TEN_DECIMALS) {
                return (MAX_ALLOWED_OVER_TEN_DECIMALS * statedOutput) / ONE_IN_TEN_DECIMALS;
            } else {
                return (theFraction * statedOutput) / ONE_IN_TEN_DECIMALS;
            }
        }
    }

    /* DEPOSIT FUNCTIONALITY */
    function canClaimShares(address theAddress) public view returns (bool) {
        LockedDeposit storage myDeposit = lockedDeposits[theAddress];
        return (myDeposit.shareAmount > 0) && (myDeposit.lockedUntil <= block.timestamp);
    }

    function claimShares() external returns (uint256 shares) {
        require(canClaimShares(msg.sender), "Setwise: shares are still locked");
        shares = lockedDeposits[msg.sender].shareAmount;
        delete lockedDeposits[msg.sender];

        _transfer(address(this), msg.sender, shares);
    }

    function _mintOrVesting(address investor, uint256 lockDays, uint256 shares) internal {
        if (lockDays == 0) {
            // No vesting period required - mint tokens directly for the user
            _mint(investor, shares);
        } else {
            // Set up a vesting deposit for the investor
            _createVestingDeposit(investor, lockDays, shares);
        }
    }

    // Mints tokens to this contract to hold for vesting
    function _createVestingDeposit(address theAddress, uint256 lockDays, uint256 shareAmount) internal {
        require(lockDays > 0, "Setwise: lock period must be positive");
        require(lockedDeposits[theAddress].shareAmount == 0, "Setwise: investor already has locked shares");

        LockedDeposit memory myDeposit = LockedDeposit({
            lockedUntil: block.timestamp + (lockDays * 1 days),
            shareAmount: shareAmount
        });
        lockedDeposits[theAddress] = myDeposit;
        _mint(address(this), shareAmount);
    }

    function depositPortfolio(
        uint256[] calldata depositAmounts,
        uint256 lockDays,
        uint256 shares,
        uint256 deadline,
        Signature calldata signature
    ) external {
        uint256 i = 0;
        uint256 n = depositAmounts.length;
        while (i < n) {
            uint256 transferAmount = depositAmounts[i];
            if (transferAmount > 0) {
                IERC20(assetAt(i)).safeTransferFrom(msg.sender, address(this), transferAmount);
            }
            i++;
        }
        settlePortfolioDeposit(msg.sender, depositAmounts, lockDays, shares, deadline, signature);
    }

    function depositSingleAsset(
        address inputAsset,
        uint256 inputAmount,
        uint256 lockDays,
        uint256 shares,
        uint256 deadline,
        Signature calldata signature
    ) external virtual;

    function settlePortfolioDeposit(
        address investor,
        uint256[] calldata depositAmounts,
        uint256 lockDays,
        uint256 shares,
        uint256 deadline,
        Signature calldata signature
    ) public payable virtual;

    function settleSingleAssetDeposit(
        address investor,
        address inputAsset,
        uint256 inputAmount,
        uint256 lockDays,
        uint256 shares,
        uint256 deadline,
        Signature calldata signature
    ) public payable virtual;

    /* WITHDRAWAL FUNCTIONALITY */
    function _proportionalWithdrawal(uint256 myFraction) internal {
        uint256 toTransfer;

        uint256 i;
        uint256 n = assetCount();
        while (i < n) {
            address theToken = assetAt(i);
            toTransfer = (myFraction * recordedBalance(theToken)) / ONE_IN_TEN_DECIMALS;
            // syncs done automatically on transfer
            _transferAsset(theToken, msg.sender, toTransfer);
            i++;
        }
    }

    function withdrawPortfolio(uint256 amount) external {
        // Capture the fraction first, before burning
        uint256 theFractionBaseTen = (ONE_IN_TEN_DECIMALS * amount) / totalSupply();

        // Reverts if balance is insufficient
        _burn(msg.sender, amount);

        _proportionalWithdrawal(theFractionBaseTen);
        emit PortfolioWithdrawn(msg.sender, amount, theFractionBaseTen);
    }

    function withdrawSingleAsset(
        address investor,
        uint256 sharesToBurn,
        address assetAddress,
        uint256 assetAmount,
        uint256 deadline,
        Signature calldata signature
    ) external virtual;

    /* SWAP Functionality: Virtual */
    function swapExactNativeForAsset(
        address outputAsset,
        uint256 inputAmount,
        uint256 outputAmount,
        uint256 deadline,
        address recipient,
        Signature calldata signature,
        bytes calldata auxiliaryData
    ) external payable virtual;
    function settleAssetForNativeSwap(
        address inputAsset,
        uint256 inputAmount,
        uint256 outputAmount,
        uint256 deadline,
        address recipient,
        Signature calldata signature,
        bytes calldata auxiliaryData
    ) external virtual;
    function swapExactAssetForNative(
        address inputAsset,
        uint256 inputAmount,
        uint256 outputAmount,
        uint256 deadline,
        address recipient,
        Signature calldata signature,
        bytes calldata auxiliaryData
    ) external virtual;
    function swapExactAssetForAsset(
        address inputAsset,
        address outputAsset,
        uint256 inputAmount,
        uint256 outputAmount,
        uint256 deadline,
        address recipient,
        Signature calldata signature,
        bytes calldata auxiliaryData
    ) external virtual;
    function settleAssetForAssetSwap(
        address inputAsset,
        address outputAsset,
        uint256 inputAmount,
        uint256 outputAmount,
        uint256 deadline,
        address recipient,
        Signature calldata signature,
        bytes calldata auxiliaryData
    ) public virtual;

    /* SIGNING Functionality */
    function createDomainSeparator(
        string memory name,
        string memory version,
        address quoteSigner
    ) internal view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    EIP712DOMAIN_TYPEHASH,
                    keccak256(abi.encodePacked(name)),
                    keccak256(abi.encodePacked(version)),
                    uint256(block.chainid),
                    quoteSigner
                )
            );
    }

    function hashSwapQuote(
        address inputAsset,
        address outputAsset,
        uint256 inputAmount,
        uint256 outputAmount,
        uint256 deadline,
        address recipient
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(SWAP_QUOTE_TYPEHASH, inputAsset, outputAsset, inputAmount, outputAmount, deadline, recipient)
            );
    }

    function hashDeposit(
        address investor,
        uint256[] calldata depositAmounts,
        uint256 daysLocked,
        uint256 shares,
        uint256 deadline
    ) internal pure returns (bytes32) {
        bytes32 depositAmountsHash = keccak256(abi.encodePacked(depositAmounts));
        return
            keccak256(
                abi.encode(PORTFOLIO_DEPOSIT_TYPEHASH, investor, depositAmountsHash, daysLocked, shares, deadline)
            );
    }

    function hashSingleDeposit(
        address investor,
        address inputAsset,
        uint256 inputAmount,
        uint256 daysLocked,
        uint256 shares,
        uint256 deadline
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    SINGLE_ASSET_DEPOSIT_TYPEHASH,
                    investor,
                    inputAsset,
                    inputAmount,
                    daysLocked,
                    shares,
                    deadline
                )
            );
    }

    function hashWithdrawal(
        address investor,
        uint256 sharesToBurn,
        address assetAddress,
        uint256 assetAmount,
        uint256 deadline
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    SINGLE_ASSET_WITHDRAWAL_TYPEHASH,
                    investor,
                    sharesToBurn,
                    assetAddress,
                    assetAmount,
                    deadline
                )
            );
    }

    function createSwapQuoteDigest(
        address inputAsset,
        address outputAsset,
        uint256 inputAmount,
        uint256 outputAmount,
        uint256 deadline,
        address recipient
    ) internal view returns (bytes32 digest) {
        bytes32 hashedInput = hashSwapQuote(inputAsset, outputAsset, inputAmount, outputAmount, deadline, recipient);
        digest = ECDSA.toTypedDataHash(QUOTE_DOMAIN_SEPARATOR, hashedInput);
    }

    function createDepositDigest(
        address investor,
        uint256[] calldata depositAmounts,
        uint256 lockDays,
        uint256 shares,
        uint256 deadline
    ) internal view returns (bytes32 depositDigest) {
        bytes32 hashedInput = hashDeposit(investor, depositAmounts, lockDays, shares, deadline);
        depositDigest = ECDSA.toTypedDataHash(QUOTE_DOMAIN_SEPARATOR, hashedInput);
    }

    function createSingleDepositDigest(
        address investor,
        address inputAsset,
        uint256 inputAmount,
        uint256 lockDays,
        uint256 shares,
        uint256 deadline
    ) internal view returns (bytes32 depositDigest) {
        bytes32 hashedInput = hashSingleDeposit(investor, inputAsset, inputAmount, lockDays, shares, deadline);
        depositDigest = ECDSA.toTypedDataHash(QUOTE_DOMAIN_SEPARATOR, hashedInput);
    }

    function createWithdrawalDigest(
        address investor,
        uint256 sharesToBurn,
        address assetAddress,
        uint256 assetAmount,
        uint256 deadline
    ) internal view returns (bytes32 withdrawalDigest) {
        bytes32 hashedInput = hashWithdrawal(investor, sharesToBurn, assetAddress, assetAmount, deadline);
        withdrawalDigest = ECDSA.toTypedDataHash(QUOTE_DOMAIN_SEPARATOR, hashedInput);
    }

    function verifyDigestSignature(bytes32 theDigest, Signature calldata signature) internal view {
        address signingAddress = ECDSA.recover(theDigest, signature.v, signature.r, signature.s);

        if (signingAddress != QUOTE_SIGNER) {
            // Check for signing with embedded tx.origin
            signingAddress = ECDSA.recover(
                keccak256(abi.encodePacked(theDigest, tx.origin)),
                signature.v,
                signature.r,
                signature.s
            );
            if (signingAddress != QUOTE_SIGNER) {
                revert InvalidSignature();
            }
        }
    }
}
