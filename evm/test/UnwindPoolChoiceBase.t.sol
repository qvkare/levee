// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {LeveeUnwind} from "../src/LeveeUnwind.sol";
import {IUniswapV3Pool} from "../src/interfaces/IUniswapV3.sol";
import {TestnetPoolMath} from "../script/lib/TestnetPool.sol";
import {ForkTarget, Targets} from "./lib/AaveFork.sol";
import {UnwindFork, UnwindTarget, UnwindTargets} from "./lib/UnwindFork.sol";
import {PoolSwapper} from "./lib/UnwindActors.sol";

interface IPoolLiquidity {
    function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes calldata data)
        external
        returns (uint256, uint256);
}

/// An LP account that pays for its own mints.
contract RogueLiquidity {
    using SafeERC20 for IERC20;

    address private transient _pool;

    function mint(address pool, int24 lower, int24 upper, uint128 liquidity) external {
        _pool = pool;
        IPoolLiquidity(pool).mint(address(this), lower, upper, liquidity, "");
        _pool = address(0);
    }

    function uniswapV3MintCallback(uint256 owed0, uint256 owed1, bytes calldata) external {
        require(msg.sender == _pool, "not the pool");
        if (owed0 > 0) IERC20(IUniswapV3Pool(msg.sender).token0()).safeTransfer(msg.sender, owed0);
        if (owed1 > 0) IERC20(IUniswapV3Pool(msg.sender).token1()).safeTransfer(msg.sender, owed1);
    }
}

/// L-1, the auditor's test_F2 in AuditPoolChoice.t.sol. A compromised rescuer is not
/// held to the borrower's pool: it routes the sale through Base's near-empty 0.04% tier
/// for the same pair, which an accomplice has priced 0.9% under the oracle, inside the
/// borrower's 1% bound, and filled with their own liquidity. Before the fix the unwind
/// went through and the accomplice kept the bound as profit, with no ordering race.
/// Now the borrower names the pool in `authorize`, and any other is refused.
contract UnwindPoolChoiceBaseTest is UnwindFork {
    uint24 internal constant ROGUE_FEE = 400;
    int24 internal constant ROGUE_SPACING = 8;
    /// Tenths of a basis point below the oracle.
    uint256 internal constant ROGUE_DISCOUNT = 900;

    function forkTarget() internal pure override returns (ForkTarget memory) {
        return Targets.base();
    }

    function unwindTarget() internal pure override returns (UnwindTarget memory) {
        return UnwindTargets.base();
    }

    function test_rescuerRoutingThroughAnotherPool_isRefused() public {
        openPosition(borrower, COLLATERAL, START_HF);
        authorizeAndApprove(borrower, SLIPPAGE_BPS, TRIGGER_HF, TARGET_HF, COLLATERAL, 500);
        uint256 amount = keeperRepay(borrower, TARGET_HF, SLIPPAGE_BPS, 500);
        address rogue = uniFactory.getPool(address(weth), address(usdc), ROGUE_FEE);
        assertTrue(rogue != address(0), "Base has a 0.04% WETH/USDC pool");
        primeRoguePool(rogue);

        // The sale the accomplice set up is inside the borrower's oracle bound...
        assertLe(quoteRogue(amount), maxCollateralIn(amount, SLIPPAGE_BPS), "the rogue price is within the bound");

        uint256 debt = vDebtUsdc.balanceOf(borrower);
        uint256 collateral = aWeth.balanceOf(borrower);
        // ...but the borrower authorized the 0.05% pool, so the helper refuses the call.
        vm.prank(rescuer);
        vm.expectRevert(abi.encodeWithSelector(LeveeUnwind.TermsMismatch.selector, address(weth), ROGUE_FEE));
        helper.unwind(borrower, address(weth), amount, ROGUE_FEE, type(uint256).max);
        assertEq(vDebtUsdc.balanceOf(borrower), debt, "debt moved");
        assertEq(aWeth.balanceOf(borrower), collateral, "collateral moved");

        // The authorized pool still works for the honest keeper.
        unwindAndCheck(borrower, amount, 500);
    }

    /// Moves the rogue pool to ROGUE_DISCOUNT below the oracle and puts USDC-only
    /// liquidity in the two tick spacings under that price, as the auditor did.
    function primeRoguePool(address rogue) internal {
        PoolSwapper mover = new PoolSwapper();
        deal(address(weth), address(mover), 1_000 ether);
        deal(address(usdc), address(mover), 5_000_000e6);
        RogueLiquidity lp = new RogueLiquidity();
        deal(address(usdc), address(lp), 5_000_000e6);

        uint160 oracleSqrt = TestnetPoolMath.oracleSqrtPriceX96(
            oracle.getAssetPrice(address(weth)), 1e18, oracle.getAssetPrice(address(usdc)), USDC_UNIT
        ); // WETH is token0 on Base
        uint256 f = sqrtWad((100_000 - ROGUE_DISCOUNT) * 1e36 / 100_000);
        uint160 targetSqrt = SafeCast.toUint160(uint256(oracleSqrt) * f / 1e18);
        (uint160 current,,,,,,) = IUniswapV3Pool(rogue).slot0();
        if (current > targetSqrt) mover.swap(IUniswapV3Pool(rogue), true, 1_000 ether, targetSqrt);
        else if (current < targetSqrt) mover.swap(IUniswapV3Pool(rogue), false, 5_000_000e6, targetSqrt);
        (, int24 tick,,,,,) = IUniswapV3Pool(rogue).slot0();
        int24 upper = TestnetPoolMath.floorToSpacing(tick, ROGUE_SPACING);
        lp.mint(rogue, upper - 2 * ROGUE_SPACING, upper, 1e18);
    }

    function quoteRogue(uint256 amount) internal returns (uint256) {
        return quoteSale(amount, ROGUE_FEE);
    }

    function sqrtWad(uint256 x) internal pure returns (uint256 y) {
        y = x;
        uint256 z = (x + 1) / 2;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}
