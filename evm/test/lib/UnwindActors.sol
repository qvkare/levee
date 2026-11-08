// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IUniswapV3Pool, IUniswapV3SwapCallback} from "../../src/interfaces/IUniswapV3.sol";

interface IUniswapV3PoolActions {
    function initialize(uint160 sqrtPriceX96) external;

    function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes calldata data)
        external
        returns (uint256 amount0, uint256 amount1);
}

interface IUniswapV3FactoryOwner {
    function owner() external view returns (address);

    function enableFeeAmount(uint24 fee, int24 tickSpacing) external;

    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);
}

/// Swaps on a real pool and pays from its own balance. Stands in for a whale or a
/// sandwich bot moving the price.
contract PoolSwapper is IUniswapV3SwapCallback {
    using SafeERC20 for IERC20;

    address private transient _pool;

    function swap(IUniswapV3Pool pool, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96)
        external
        returns (int256 amount0, int256 amount1)
    {
        _pool = address(pool);
        (amount0, amount1) = pool.swap(address(this), zeroForOne, amountSpecified, sqrtPriceLimitX96, "");
        _pool = address(0);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        require(msg.sender == _pool, "not the pool");
        IUniswapV3Pool pool = IUniswapV3Pool(msg.sender);
        if (amount0Delta > 0) IERC20(pool.token0()).safeTransfer(msg.sender, SafeCast.toUint256(amount0Delta));
        if (amount1Delta > 0) IERC20(pool.token1()).safeTransfer(msg.sender, SafeCast.toUint256(amount1Delta));
    }
}

/// Adds liquidity to a real pool from its own balance.
contract PoolMinter {
    using SafeERC20 for IERC20;

    address private transient _pool;

    function mint(IUniswapV3Pool pool, int24 tickLower, int24 tickUpper, uint128 liquidity) external {
        _pool = address(pool);
        IUniswapV3PoolActions(address(pool)).mint(address(this), tickLower, tickUpper, liquidity, "");
        _pool = address(0);
    }

    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata) external {
        require(msg.sender == _pool, "not the pool");
        IUniswapV3Pool pool = IUniswapV3Pool(msg.sender);
        if (amount0Owed > 0) IERC20(pool.token0()).safeTransfer(msg.sender, amount0Owed);
        if (amount1Owed > 0) IERC20(pool.token1()).safeTransfer(msg.sender, amount1Owed);
    }
}

/// Calls the helper's swap callback directly, as a fake pool would.
contract FakePool {
    function callBack(IUniswapV3SwapCallback target, int256 amount0Delta, int256 amount1Delta, bytes calldata data)
        external
    {
        target.uniswapV3SwapCallback(amount0Delta, amount1Delta, data);
    }
}

/// What the test calls on the etched token to arm it and to read what happened. Handled
/// in ReentrantToken's fallback, so every other selector reaches the real token code.
interface IReentrantToken {
    function arm() external;

    /// The revert selector of each re-entry, or all ones if it succeeded.
    function results() external view returns (bytes32 unwindResult, bytes32 callbackResult);
}

/// A collateral token that re-enters the helper while Aave pays the Uniswap pool.
///
/// Its runtime code is etched over the real collateral token. Every call is delegated to
/// a copy of the original code, so balances and behaviour are the real token's. When
/// armed, a `transfer` to `POOL` first tries to unwind another borrower who authorized
/// this token as their rescuer, then tries the swap callback, and records how each call
/// ended before letting the transfer through.
contract ReentrantToken {
    bytes32 internal constant ARMED_SLOT = keccak256("levee.test.reentrant-token.armed");
    bytes32 internal constant UNWIND_RESULT_SLOT = keccak256("levee.test.reentrant-token.unwind-result");
    bytes32 internal constant CALLBACK_RESULT_SLOT = keccak256("levee.test.reentrant-token.callback-result");

    address internal immutable ORIGINAL;
    address internal immutable HELPER;
    address internal immutable POOL;
    address internal immutable VICTIM;
    uint24 internal immutable FEE;
    uint256 internal immutable AMOUNT;

    constructor(address original, address helper, address pool, address victim, uint24 fee, uint256 amount) {
        ORIGINAL = original;
        HELPER = helper;
        POOL = pool;
        VICTIM = victim;
        FEE = fee;
        AMOUNT = amount;
    }

    fallback() external payable {
        if (msg.sig == IReentrantToken.arm.selector) {
            _store(ARMED_SLOT, bytes32(uint256(1)));
            return;
        }
        if (msg.sig == IReentrantToken.results.selector) {
            bytes32 unwindResult = _load(UNWIND_RESULT_SLOT);
            bytes32 callbackResult = _load(CALLBACK_RESULT_SLOT);
            assembly {
                mstore(0x00, unwindResult)
                mstore(0x20, callbackResult)
                return(0x00, 0x40)
            }
        }
        if (msg.sig == IERC20.transfer.selector && _load(ARMED_SLOT) != 0) {
            (address to,) = abi.decode(msg.data[4:], (address, uint256));
            if (to == POOL) {
                _store(ARMED_SLOT, 0);
                _reenter();
            }
        }
        _delegate();
    }

    function _reenter() internal {
        (bool ok, bytes memory ret) = HELPER.call(
            abi.encodeWithSignature(
                "unwind(address,address,uint256,uint24,uint256)", VICTIM, address(this), AMOUNT, FEE, type(uint256).max
            )
        );
        _store(UNWIND_RESULT_SLOT, _result(ok, ret));

        bytes memory data = abi.encode(
            VICTIM, address(this), address(0), address(0), AMOUNT, type(uint256).max, type(uint256).max, true
        );
        (ok, ret) = HELPER.call(
            abi.encodeWithSelector(
                IUniswapV3SwapCallback.uniswapV3SwapCallback.selector, int256(1), -SafeCast.toInt256(AMOUNT), data
            )
        );
        _store(CALLBACK_RESULT_SLOT, _result(ok, ret));
    }

    /// The revert selector, or all ones for a call that succeeded.
    function _result(bool ok, bytes memory ret) internal pure returns (bytes32) {
        if (ok) return bytes32(type(uint256).max);
        if (ret.length < 4) return bytes32(0);
        // A revert selector is the first four bytes of the data.
        // forge-lint: disable-next-line(unsafe-typecast)
        return bytes32(bytes4(ret));
    }

    function _delegate() internal {
        address original = ORIGINAL;
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), original, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }

    function _store(bytes32 slot, bytes32 value) internal {
        assembly {
            sstore(slot, value)
        }
    }

    function _load(bytes32 slot) internal view returns (bytes32 value) {
        assembly {
            value := sload(slot)
        }
    }
}
