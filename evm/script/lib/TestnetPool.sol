// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IUniswapV3Factory, IUniswapV3Pool, IUniswapV3SwapCallback} from "../../src/interfaces/IUniswapV3.sol";

// Testnet tooling for SeedTestnetPool. None of this is part of the helper.

/// Uniswap v3-periphery 1.0.0 NonfungiblePositionManager, the calls the seed script makes.
interface INonfungiblePositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    function factory() external view returns (address);

    function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96)
        external
        payable
        returns (address pool);

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
}

interface IWETH9 {
    function deposit() external payable;
}

/// Aave's Base Sepolia faucet, as deployed. It differs from the Faucet in aave-v3-origin:
/// each token has a per-call limit in whole tokens and a per-address timelock, read on
/// chain at block 56,000,000 as 1,000,000 test USDC and 3,600 seconds.
interface IAaveFaucet {
    function mint(address token, address to, uint256 amount) external returns (uint256);

    function getTokenConfig(address token) external view returns (uint256 timelockSeconds, uint256 maxMintWhole);

    function getUserLastUpdated(address token, address user) external view returns (uint256);
}

library TestnetPoolMath {
    /// The sqrtPriceX96 at which one base unit of token0 trades for the oracle value of
    /// token1 base units. Prices are Aave oracle prices of one whole token, in the same
    /// base currency.
    function oracleSqrtPriceX96(uint256 price0, uint256 unit0, uint256 price1, uint256 unit1)
        internal
        pure
        returns (uint160)
    {
        // Pool price = token1 base units per token0 base unit = price0 * unit1 / (price1 * unit0).
        uint256 ratioX192 = Math.mulDiv(price0 * unit1, 1 << 192, price1 * unit0);
        return SafeCast.toUint160(Math.sqrt(ratioX192));
    }

    /// Rounds a tick down to a multiple of `spacing`.
    function floorToSpacing(int24 tick, int24 spacing) internal pure returns (int24) {
        // Truncating first is the point: it drops the remainder.
        // forge-lint: disable-next-line(divide-before-multiply)
        int24 rounded = (tick / spacing) * spacing;
        if (tick < 0 && tick % spacing != 0) rounded -= spacing;
        return rounded;
    }
}

/// Moves a Uniswap v3 pool's price to a target with one swap that stops at the target.
/// The caller pays, from an allowance to this contract, and receives the output.
///
/// SwapRouter02 cannot do this: it refuses a swap in which nothing changes hands, which
/// is what moving across an empty price range is.
contract PoolPriceMover is IUniswapV3SwapCallback {
    using SafeERC20 for IERC20;

    IUniswapV3Factory public immutable FACTORY;

    address private transient _pool;
    address private transient _payer;

    error NoPool();
    error NotThePool();
    error TargetNotReached(uint160 reached, uint160 target);

    constructor(IUniswapV3Factory factory) {
        FACTORY = factory;
    }

    /// Spends at most `maxIn` of the input token. Reverts if that is not enough to reach
    /// `targetSqrtPriceX96`.
    function moveTo(address tokenA, address tokenB, uint24 fee, uint160 targetSqrtPriceX96, uint256 maxIn)
        external
        returns (int256 amount0, int256 amount1)
    {
        address pool = FACTORY.getPool(tokenA, tokenB, fee);
        if (pool == address(0)) revert NoPool();
        (uint160 current,,,,,,) = IUniswapV3Pool(pool).slot0();
        if (current == targetSqrtPriceX96) return (0, 0);

        _pool = pool;
        _payer = msg.sender;
        (amount0, amount1) = IUniswapV3Pool(pool)
            .swap(msg.sender, targetSqrtPriceX96 < current, SafeCast.toInt256(maxIn), targetSqrtPriceX96, "");
        _pool = address(0);
        _payer = address(0);

        (uint160 reached,,,,,,) = IUniswapV3Pool(pool).slot0();
        if (reached != targetSqrtPriceX96) revert TargetNotReached(reached, targetSqrtPriceX96);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (_pool == address(0) || msg.sender != _pool) revert NotThePool();
        if (amount0Delta > 0) {
            IERC20(IUniswapV3Pool(msg.sender).token0())
                .safeTransferFrom(_payer, msg.sender, SafeCast.toUint256(amount0Delta));
        }
        if (amount1Delta > 0) {
            IERC20(IUniswapV3Pool(msg.sender).token1())
                .safeTransferFrom(_payer, msg.sender, SafeCast.toUint256(amount1Delta));
        }
    }
}
