// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {LeveeUnwind} from "../../src/LeveeUnwind.sol";
import {IAaveAddressesProvider} from "../../src/interfaces/IAaveV3.sol";
import {IUniswapV3Pool} from "../../src/interfaces/IUniswapV3.sol";
import {Deployments, UnwindArgs} from "../../script/lib/Deployments.sol";
import {TestnetPoolMath} from "../../script/lib/TestnetPool.sol";
import {IAaveErrors, IERC20Like, IPoolAddressesProvider} from "./AaveInterfaces.sol";
import {
    FakePool,
    IReentrantToken,
    IUniswapV3FactoryOwner,
    IUniswapV3PoolActions,
    MockSentinel,
    PoolMinter,
    PoolSwapper,
    ReentrantToken
} from "./UnwindActors.sol";
import {IPoolEMode, UnwindFork} from "./UnwindFork.sol";

/// Aave's own names, kept as they are.
interface IAddressesProviderAdmin {
    function getPoolConfigurator() external view returns (address);

    // forge-lint: disable-next-line(mixed-case-function)
    function getACLManager() external view returns (address);

    // forge-lint: disable-next-line(mixed-case-function)
    function getACLAdmin() external view returns (address);
}

interface IACLManager {
    function addPoolAdmin(address admin) external;
}

interface IPoolConfigurator {
    function setReserveFreeze(address asset, bool freeze) external;

    function setReservePause(address asset, bool paused) external;

    function configureReserveAsCollateral(
        address asset,
        uint256 ltv,
        uint256 liquidationThreshold,
        uint256 liquidationBonus
    ) external;

    function setEModeCategory(
        uint8 categoryId,
        uint16 ltv,
        uint16 liquidationThreshold,
        uint16 liquidationBonus,
        string calldata label
    ) external;

    function setAssetCollateralInEMode(address asset, uint8 categoryId, bool allowed) external;

    function setAssetBorrowableInEMode(address asset, uint8 categoryId, bool borrowable) external;
}

interface IPoolCollateral {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;

    function setUserUseReserveAsCollateral(address asset, bool useAsCollateral) external;

    function getConfiguration(address asset) external view returns (uint256);

    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

/// LeveeUnwind against the live Aave and Uniswap deployments. Base, Arbitrum and Base
/// Sepolia inherit it unchanged, so every chain is held to the same assertions.
abstract contract UnwindPath is UnwindFork {
    uint160 internal constant MIN_SQRT = 4_295_128_740;
    uint160 internal constant MAX_SQRT = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341;
    /// No cap from the rescuer: only the borrower's oracle bound applies, as it would for
    /// a stolen keeper key.
    uint256 internal constant NO_CAP = type(uint256).max;

    // ---- chain facts --------------------------------------------------------------------

    function test_chainFacts() public view {
        assertEq(LeveeUnwind.unwind.selector, bytes4(0x65afae08), "unwind selector");
        assertEq(LeveeUnwind.authorize.selector, bytes4(0x4d4bb5b7), "authorize selector");
        assertEq(LeveeUnwind.authorizationOf.selector, bytes4(0xcc90b6bb), "authorizationOf selector");
        assertEq(LeveeUnwind.revoke.selector, bytes4(0xb6549f75), "revoke selector");

        UnwindArgs memory args = Deployments.unwindArgs(block.chainid);
        assertEq(args.usdc, target.usdc, "USDC differs from docs/SPEC.md section 3");
        assertEq(pool.ADDRESSES_PROVIDER(), args.addressesProvider, "the Pool reports another provider");
        assertEq(IAaveAddressesProvider(args.addressesProvider).getPool(), target.pool, "provider points elsewhere");
        assertGt(IERC20(address(vDebtUsdc)).totalSupply(), 0, "USDC reserve has no variable debt");

        assertEq(args.uniswapV3Factory, ut.uniswapV3Factory, "factory differs");
        assertGt(ut.uniswapV3Factory.code.length, 0, "no factory");
        assertEq(uniFactory.feeAmountTickSpacing(500), 10, "factory tick spacing for 0.05%");
        assertEq(uniFactory.feeAmountTickSpacing(3000), 60, "factory tick spacing for 0.30%");

        // The keeper's QuoterV2, from Uniswap's deployments feed, is the periphery of this
        // factory and this chain's WETH.
        assertGt(address(quoter).code.length, 0, "no QuoterV2");
        assertEq(quoter.factory(), ut.uniswapV3Factory, "QuoterV2 is on another factory");
        assertEq(quoter.WETH9(), address(weth), "QuoterV2 WETH9");

        assertEq(address(uniPool), ut.deepPool, "deep pool address");
        assertEq(uniPool.fee(), ut.deepFee, "deep pool fee");
        (address token0, address token1) =
            address(weth) < address(usdc) ? (address(weth), address(usdc)) : (address(usdc), address(weth));
        assertEq(uniPool.token0(), token0, "deep pool token0");
        assertEq(uniPool.token1(), token1, "deep pool token1");
        if (ut.otherFee != 0) {
            assertEq(uniFactory.getPool(address(weth), address(usdc), ut.otherFee), ut.otherPool, "other pool");
        }

        uint24[4] memory fees = [uint24(100), 500, 3000, 10000];
        for (uint256 i = 0; i < fees.length; i++) {
            address candidate = uniFactory.getPool(address(weth), address(usdc), fees[i]);
            if (candidate == address(0)) continue;
            assertLe(IUniswapV3Pool(candidate).liquidity(), uniPool.liquidity(), "a deeper pool exists");
        }
        assertEq(addressesProvider().getPriceOracleSentinel(), address(0), "the fork has a sentinel now");
        console2.log(target.name, "Pool revision", pool.POOL_REVISION());
    }

    // ---- the happy path ----------------------------------------------------------------

    function test_unwind_deepestPool_fromNearLiquidationToTarget() public {
        openRescuable(borrower, START_HF);
        assertApproxEqRel(healthFactorOf(borrower), START_HF, 1e12, "position opens at 1.05");

        uint256 amount = keeperRepay(borrower, TARGET_HF, SLIPPAGE_BPS, ut.deepFee);
        Outcome memory o = unwindAndCheck(borrower, amount, ut.deepFee);

        assertGe(o.afterwards.healthFactor, TARGET_HF, "keeper sizing reaches the target");
        assertApproxEqRel(o.afterwards.healthFactor, TARGET_HF, 0.02e18, "lands near the target");
        logOutcome("deepest pool", o);
    }

    function test_unwind_otherPool_fromNearLiquidationToTarget() public {
        vm.skip(ut.otherFee == 0);
        openPosition(borrower, COLLATERAL, START_HF);
        authorizeAndApprove(borrower, SLIPPAGE_BPS, TRIGGER_HF, TARGET_HF, COLLATERAL, ut.otherFee);
        uint256 amount = keeperRepay(borrower, TARGET_HF, SLIPPAGE_BPS, ut.otherFee);
        Outcome memory o = unwindAndCheck(borrower, amount, ut.otherFee);
        assertGe(o.afterwards.healthFactor, TARGET_HF, "keeper sizing reaches the target");
        logOutcome("other fee tier", o);
    }

    // ---- authorization -----------------------------------------------------------------

    function test_authorize_storesAndEmits_revokeClears() public {
        vm.expectEmit(address(helper));
        emit LeveeUnwind.Authorized(borrower, rescuer, address(weth), ut.deepFee, 150, 1.1e18, 1.6e18);
        vm.prank(borrower);
        helper.authorize(rescuer, 150, 1.1e18, 1.6e18, address(weth), ut.deepFee);

        (address r, uint16 s, uint64 t, uint64 g, address c, uint24 f) = helper.authorizationOf(borrower);
        assertEq(r, rescuer, "rescuer");
        assertEq(s, 150, "slippage");
        assertEq(t, 1.1e18, "trigger");
        assertEq(g, 1.6e18, "target");
        assertEq(c, address(weth), "collateral");
        assertEq(f, ut.deepFee, "pool fee");

        vm.expectEmit(address(helper));
        emit LeveeUnwind.Revoked(borrower, rescuer);
        vm.prank(borrower);
        helper.revoke();
        (r, s, t, g, c, f) = helper.authorizationOf(borrower);
        assertEq(r, address(0), "rescuer cleared");
        assertEq(c, address(0), "collateral cleared");
        assertEq(uint256(s) + t + g + f, 0, "limits cleared");

        // A second revoke is a no-op, so the stop button never fails.
        vm.prank(borrower);
        helper.revoke();
    }

    function test_authorize_rejectsBadValues() public {
        address w = address(weth);
        uint24 fee = ut.deepFee;
        vm.startPrank(borrower);
        vm.expectRevert(LeveeUnwind.InvalidRescuer.selector);
        helper.authorize(address(0), SLIPPAGE_BPS, TRIGGER_HF, TARGET_HF, w, fee);

        vm.expectRevert(abi.encodeWithSelector(LeveeUnwind.InvalidSlippage.selector, 0));
        helper.authorize(rescuer, 0, TRIGGER_HF, TARGET_HF, w, fee);
        vm.expectRevert(abi.encodeWithSelector(LeveeUnwind.InvalidSlippage.selector, 301));
        helper.authorize(rescuer, 301, TRIGGER_HF, TARGET_HF, w, fee);

        uint64[2][6] memory bad = [
            [uint64(1e18), TARGET_HF], // trigger at liquidation
            [uint64(0.9e18), TARGET_HF], // trigger below liquidation
            [uint64(0), TARGET_HF],
            [uint64(1.5e18), 1.5e18], // trigger at target
            [uint64(1.6e18), 1.5e18], // trigger above target
            [uint64(1.2e18), 3e18 + 1] // target above the cap
        ];
        for (uint256 i = 0; i < bad.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(LeveeUnwind.InvalidHealthFactors.selector, bad[i][0], bad[i][1]));
            helper.authorize(rescuer, SLIPPAGE_BPS, bad[i][0], bad[i][1], w, fee);
        }

        // The collateral must be an Aave reserve other than USDC, with a pool at that fee.
        vm.expectRevert(LeveeUnwind.CollateralIsUsdc.selector);
        helper.authorize(rescuer, SLIPPAGE_BPS, TRIGGER_HF, TARGET_HF, address(usdc), fee);
        address notAReserve = makeAddr("not a reserve");
        vm.expectRevert(abi.encodeWithSelector(LeveeUnwind.NotAnAaveReserve.selector, notAReserve));
        helper.authorize(rescuer, SLIPPAGE_BPS, TRIGGER_HF, TARGET_HF, notAReserve, fee);
        vm.expectRevert(abi.encodeWithSelector(LeveeUnwind.NotAnAaveReserve.selector, address(0)));
        helper.authorize(rescuer, SLIPPAGE_BPS, TRIGGER_HF, TARGET_HF, address(0), fee);
        uint24[3] memory noPool = [uint24(0), 1234, 2500];
        for (uint256 i = 0; i < noPool.length; i++) {
            assertEq(uniFactory.getPool(w, address(usdc), noPool[i]), address(0), "tier has a pool");
            vm.expectRevert(abi.encodeWithSelector(LeveeUnwind.PoolNotFound.selector, w, noPool[i]));
            helper.authorize(rescuer, SLIPPAGE_BPS, TRIGGER_HF, TARGET_HF, w, noPool[i]);
        }
        (address stored,,,,,) = helper.authorizationOf(borrower);
        assertEq(stored, address(0), "nothing was stored");

        // The edges themselves are allowed.
        helper.authorize(rescuer, 300, 1e18 + 1, 3e18, w, fee);
        helper.authorize(rescuer, 1, 1e18 + 1, 1e18 + 2, w, fee);
        vm.stopPrank();
    }

    function testFuzz_authorize_healthFactorBounds(uint64 trigger, uint64 targetHf) public {
        bool valid = trigger > 1e18 && trigger < targetHf && targetHf <= 3e18;
        vm.prank(borrower);
        if (!valid) {
            vm.expectRevert(abi.encodeWithSelector(LeveeUnwind.InvalidHealthFactors.selector, trigger, targetHf));
        }
        helper.authorize(rescuer, SLIPPAGE_BPS, trigger, targetHf, address(weth), ut.deepFee);
        if (valid) {
            (,, uint64 t, uint64 g,,) = helper.authorizationOf(borrower);
            assertEq(t, trigger, "trigger stored");
            assertEq(g, targetHf, "target stored");
        }
    }

    function test_unwind_byAnyoneButTheRescuer_reverts() public {
        openRescuable(borrower, START_HF);
        uint256 amount = keeperRepay(borrower, TARGET_HF, SLIPPAGE_BPS, ut.deepFee);

        // The rescuer of another borrower is just another stranger here.
        address otherRescuer = makeAddr("other rescuer");
        vm.prank(liquidator);
        helper.authorize(otherRescuer, SLIPPAGE_BPS, TRIGGER_HF, TARGET_HF, address(weth), ut.deepFee);

        address[5] memory callers = [borrower, liquidator, otherRescuer, address(this), address(uniPool)];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(LeveeUnwind.NotRescuer.selector);
            helper.unwind(borrower, address(weth), amount, ut.deepFee, NO_CAP);
        }
        // And nobody can act for a borrower who never authorized.
        vm.prank(rescuer);
        vm.expectRevert(LeveeUnwind.NotRescuer.selector);
        helper.unwind(liquidator, address(weth), amount, ut.deepFee, NO_CAP);
        assertHelperClean();
    }

    function test_unwind_afterRevoke_reverts() public {
        openRescuable(borrower, START_HF);
        uint256 amount = keeperRepay(borrower, TARGET_HF, SLIPPAGE_BPS, ut.deepFee);
        vm.prank(borrower);
        helper.revoke();

        Reads memory before = read(borrower, uniPool);
        vm.prank(rescuer);
        vm.expectRevert(LeveeUnwind.NotRescuer.selector);
        helper.unwind(borrower, address(weth), amount, ut.deepFee, NO_CAP);
        assertNothingMoved(before);
    }

    function test_unwind_afterAllowanceRemoved_reverts() public {
        openRescuable(borrower, START_HF);
        uint256 amount = keeperRepay(borrower, TARGET_HF, SLIPPAGE_BPS, ut.deepFee);
        vm.prank(borrower);
        aWeth.approve(address(helper), 0);

        Reads memory before = read(borrower, uniPool);
        vm.prank(rescuer);
        vm.expectRevert();
        helper.unwind(borrower, address(weth), amount, ut.deepFee, NO_CAP);
        assertNothingMoved(before);
    }

    // ---- L-1: the borrower's collateral and pool, and nothing else ------------------------

    /// A rescuer can sell only the collateral the borrower named, in the pool they named.
    /// Before the fix, `unwind` took both from the caller.
    function test_unwind_unauthorizedCollateralOrPool_reverts() public {
        openRescuable(borrower, START_HF);
        uint256 amount = keeperRepay(borrower, TARGET_HF, SLIPPAGE_BPS, ut.deepFee);
        Reads memory before = read(borrower, uniPool);

        address[4] memory assets = [address(usdc), ut.secondCollateral, makeAddr("not a reserve"), address(0)];
        vm.startPrank(rescuer);
        for (uint256 i = 0; i < assets.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(LeveeUnwind.TermsMismatch.selector, assets[i], ut.deepFee));
            helper.unwind(borrower, assets[i], amount, ut.deepFee, NO_CAP);
        }
        // Every other fee tier, including one with a real pool for the same pair.
        uint24[5] memory fees = [uint24(100), 500, 3000, 10000, 2500];
        for (uint256 i = 0; i < fees.length; i++) {
            if (fees[i] == ut.deepFee) continue;
            vm.expectRevert(abi.encodeWithSelector(LeveeUnwind.TermsMismatch.selector, address(weth), fees[i]));
            helper.unwind(borrower, address(weth), amount, fees[i], NO_CAP);
        }
        vm.stopPrank();
        assertNothingMoved(before);
    }

    // ---- the trigger and the target ----------------------------------------------------

    function test_unwind_aboveTrigger_reverts() public {
        openPosition(borrower, COLLATERAL, 1.3e18);
        authorizeAndApprove(borrower, SLIPPAGE_BPS, TRIGGER_HF, TARGET_HF, COLLATERAL);
        uint256 healthFactor = healthFactorOf(borrower);

        Reads memory before = read(borrower, uniPool);
        vm.prank(rescuer);
        vm.expectRevert(abi.encodeWithSelector(LeveeUnwind.AboveTrigger.selector, healthFactor, TRIGGER_HF));
        helper.unwind(borrower, address(weth), 1_000e6, ut.deepFee, NO_CAP);
        assertNothingMoved(before);
    }

    function test_unwind_withNoDebt_isAboveTrigger() public {
        deal(address(weth), borrower, COLLATERAL);
        vm.startPrank(borrower);
        weth.approve(address(pool), COLLATERAL);
        IPoolCollateral(address(pool)).supply(address(weth), COLLATERAL, borrower, 0);
        vm.stopPrank();
        authorizeAndApprove(borrower, SLIPPAGE_BPS, TRIGGER_HF, TARGET_HF, COLLATERAL);

        vm.prank(rescuer);
        vm.expectRevert(abi.encodeWithSelector(LeveeUnwind.AboveTrigger.selector, type(uint256).max, TRIGGER_HF));
        helper.unwind(borrower, address(weth), 1_000e6, ut.deepFee, NO_CAP);
    }

    function test_unwind_justBelowTrigger_succeeds() public {
        openPosition(borrower, COLLATERAL, TRIGGER_HF - 0.001e18);
        authorizeAndApprove(borrower, SLIPPAGE_BPS, TRIGGER_HF, TARGET_HF, COLLATERAL);
        assertLt(healthFactorOf(borrower), TRIGGER_HF, "position sits just under the trigger");
        assertGt(healthFactorOf(borrower), TRIGGER_HF - 0.002e18, "and close to it");

        uint256 amount = keeperRepay(borrower, TARGET_HF, SLIPPAGE_BPS, ut.deepFee);
        Outcome memory o = unwindAndCheck(borrower, amount, ut.deepFee);
        assertGe(o.afterwards.healthFactor, TARGET_HF, "reaches the target");
    }

    function test_unwind_largeOverSale_isBlocked() public {
        openRescuable(borrower, START_HF);
        uint256 honest = keeperRepay(borrower, TARGET_HF, SLIPPAGE_BPS, ut.deepFee);
        uint256 amount = honest * 5 / 4;
        assertLt(amount, vDebtUsdc.balanceOf(borrower), "still a partial repay");

        Reads memory before = read(borrower, uniPool);
        vm.prank(rescuer);
        vm.expectPartialRevert(LeveeUnwind.OverSold.selector);
        helper.unwind(borrower, address(weth), amount, ut.deepFee, NO_CAP);
        assertNothingMoved(before);
    }

    // ---- I-1: how far past the keeper's amount the post-check lets a sale go ---------------

    /// WETH at 1.05, trigger 1.2, target 1.5, 100 bps. 1.0117 times under the old margin.
    function test_unwind_overSaleHeadroom_isSmall() public {
        openPosition(borrower, COLLATERAL, START_HF);
        authorizeAndApprove(borrower, SLIPPAGE_BPS, TRIGGER_HF, TARGET_HF, type(uint256).max);
        uint256 allowedBps = overSaleHeadroomBps(borrower, TARGET_HF, "WETH 1.05 to 1.2/1.5");
        assertLt(allowedBps, 10_100, "a sale can run more than 1% past the keeper's amount");
    }

    /// A band of 0.01: trigger 1.20, target 1.21, from 1.19. The old margin, 1% of the
    /// target, was larger than the whole move and let a sale run about half as far again.
    function test_unwind_overSaleHeadroom_narrowBand() public {
        openPosition(borrower, COLLATERAL, 1.19e18);
        authorizeAndApprove(borrower, SLIPPAGE_BPS, 1.2e18, 1.21e18, type(uint256).max);
        uint256 allowedBps = overSaleHeadroomBps(borrower, 1.21e18, "WETH 1.19 to 1.20/1.21");
        assertLt(allowedBps, 10_400, "a narrow band lets a sale run more than 4% past the keeper's amount");
    }

    /// eMode at a 95% liquidation threshold, which no USDC-borrowing category on these
    /// forks has, so the test creates one as pool admin: WETH collateral, USDC borrowable,
    /// LTV 94%, threshold 95%. From 1.02 to a 1.03 trigger and a 1.05 target.
    function test_unwind_overSaleHeadroom_eMode95() public {
        openEModePosition(borrower, COLLATERAL, 1.02e18);
        authorizeAndApprove(borrower, SLIPPAGE_BPS, 1.03e18, 1.05e18, type(uint256).max);
        uint256 allowedBps = overSaleHeadroomBps(borrower, 1.05e18, "eMode 95% 1.02 to 1.03/1.05");
        assertLt(allowedBps, 10_300, "eMode lets a sale run more than 3% past the keeper's amount");
    }

    /// The same eMode position with the default 1.2/1.5 settings.
    function test_unwind_overSaleHeadroom_eMode95_wideBand() public {
        openEModePosition(borrower, COLLATERAL, START_HF);
        authorizeAndApprove(borrower, SLIPPAGE_BPS, TRIGGER_HF, TARGET_HF, type(uint256).max);
        uint256 allowedBps = overSaleHeadroomBps(borrower, TARGET_HF, "eMode 95% 1.05 to 1.2/1.5");
        assertLt(allowedBps, 10_100, "eMode lets a sale run more than 1% past the keeper's amount");
    }

    /// An honest keeper in eMode, sized with the eMode threshold, lands at its target.
    function test_unwind_eMode95_keeperAmountPasses() public {
        openEModePosition(borrower, COLLATERAL, 1.02e18);
        authorizeAndApprove(borrower, SLIPPAGE_BPS, 1.03e18, 1.05e18, COLLATERAL);
        uint256 amount = keeperRepay(borrower, 1.05e18, SLIPPAGE_BPS, ut.deepFee);
        Outcome memory o = unwindAndCheck(borrower, amount, ut.deepFee, SLIPPAGE_BPS, 1.05e18);
        assertGe(o.afterwards.healthFactor, 1.05e18, "reaches the target");
        logOutcome("eMode 95% 1.02 to 1.05", o);
    }

    /// The cap at the debt holds, which makes it a full repay, and a full repay leaves no
    /// debt and an unbounded health factor, so the post-check refuses it.
    function test_unwind_amountAboveDebt_isCappedThenBlocked() public {
        openRescuable(borrower, START_HF);
        uint256 amount = vDebtUsdc.balanceOf(borrower) + 1_000e6;
        uint256 hfBefore = healthFactorOf(borrower);
        uint256 bound = uint256(TARGET_HF) + (uint256(TARGET_HF) - hfBefore) * helper.HF_MARGIN_BPS() / BPS;

        Reads memory before = read(borrower, uniPool);
        vm.prank(rescuer);
        // Without the cap the Pool would repay less than was swapped for, and the revert
        // would be RepayMismatch. An infinite health factor proves the whole debt was repaid.
        vm.expectRevert(abi.encodeWithSelector(LeveeUnwind.OverSold.selector, type(uint256).max, bound));
        helper.unwind(borrower, address(weth), amount, ut.deepFee, NO_CAP);
        assertNothingMoved(before);
    }

    function test_unwind_zeroAmount_reverts() public {
        openRescuable(borrower, START_HF);
        vm.prank(rescuer);
        vm.expectRevert(LeveeUnwind.ZeroAmount.selector);
        helper.unwind(borrower, address(weth), 0, ut.deepFee, NO_CAP);
    }

    // ---- M-1: the rescuer's own cap -------------------------------------------------------

    function test_unwind_zeroMaxSold_reverts() public {
        openRescuable(borrower, START_HF);
        uint256 amount = keeperRepay(borrower, TARGET_HF, SLIPPAGE_BPS, ut.deepFee);
        vm.prank(rescuer);
        vm.expectRevert(LeveeUnwind.ZeroMaxSold.selector);
        helper.unwind(borrower, address(weth), amount, ut.deepFee, 0);
    }

    /// One base unit under the quote is refused, the quote itself passes.
    function test_unwind_saleAboveMaxSold_reverts() public {
        openRescuable(borrower, START_HF);
        uint256 amount = keeperRepay(borrower, TARGET_HF, SLIPPAGE_BPS, ut.deepFee);
        uint256 quote = quoteSale(amount, ut.deepFee);

        Reads memory before = read(borrower, uniPool);
        vm.prank(rescuer);
        vm.expectRevert(abi.encodeWithSelector(LeveeUnwind.MaxSoldExceeded.selector, quote, quote - 1));
        helper.unwind(borrower, address(weth), amount, ut.deepFee, quote - 1);
        assertNothingMoved(before);

        (, uint256 sold,) = unwindAs(rescuer, borrower, amount, ut.deepFee, quote);
        assertEq(sold, quote, "an exact cap passes");
    }

    /// A cap above the borrower's oracle bound does not loosen it: a stolen keeper key can
    /// pass any `maxSold`, and the sale is still held to `maxSlippageBps`.
    function test_unwind_maxSoldCannotLoosenTheOracleBound() public {
        openRescuable(borrower, START_HF);
        uint256 amount = keeperRepay(borrower, TARGET_HF, SLIPPAGE_BPS, ut.deepFee);
        pushWethPriceDown(uniPool, 300);

        Reads memory before = read(borrower, uniPool);
        vm.prank(rescuer);
        vm.expectPartialRevert(LeveeUnwind.SlippageExceeded.selector);
        helper.unwind(borrower, address(weth), amount, ut.deepFee, NO_CAP);
        assertNothingMoved(before);
    }

    /// The auditor's sandwich, test_F1 in Audit.t.sol. A searcher who sees the signed
    /// unwind sells WETH into the pool first, lets the unwind fill, and buys back. With
    /// only the borrower's 100 bps bound the push could go almost to that bound. With the
    /// keeper's cap, a fresh quote plus 50 bps, it cannot take more than the 50 bps.
    function test_sandwich_isBoundedByTheKeepersMaxSold() public {
        Sandwich memory sw = sandwich(COLLATERAL);
        assertLe(sw.cappedSold, sw.maxSold, "the capped sale stayed under maxSold");
        assertLe(
            sw.cappedCost100 - sw.honestCost100,
            QUOTE_TOLERANCE_BPS * 100 + 100,
            "the sandwich took more than the keeper's tolerance"
        );
        assertGt(sw.uncappedCost100, sw.cappedCost100, "without the cap the push goes further");
    }

    /// The auditor's large case: about $250,000 repaid. Not on Base Sepolia, whose
    /// seeded pool is too small for a sale this size.
    function test_sandwich_largeUnwind_isBoundedByTheKeepersMaxSold() public {
        vm.skip(block.chainid == Deployments.BASE_SEPOLIA);
        Sandwich memory sw = sandwich(200 ether);
        assertLe(sw.cappedSold, sw.maxSold, "the capped sale stayed under maxSold");
        assertLe(
            sw.cappedCost100 - sw.honestCost100,
            QUOTE_TOLERANCE_BPS * 100 + 100,
            "the sandwich took more than the keeper's tolerance"
        );
    }

    // ---- price ---------------------------------------------------------------------------

    function test_unwind_slippageBoundBelowPoolCost_reverts() public {
        openPosition(borrower, COLLATERAL, START_HF);
        authorizeAndApprove(borrower, 1, TRIGGER_HF, TARGET_HF, COLLATERAL);
        uint256 amount = keeperRepay(borrower, TARGET_HF, 1, ut.deepFee);

        Reads memory before = read(borrower, uniPool);
        vm.prank(rescuer);
        vm.expectPartialRevert(LeveeUnwind.SlippageExceeded.selector);
        helper.unwind(borrower, address(weth), amount, ut.deepFee, NO_CAP);
        assertNothingMoved(before);
    }

    /// A large sale just before the unwind, as a sandwich would, moves the pool 3% below
    /// where it was. The oracle does not move, so the bound refuses the swap. The keeper's
    /// cap, quoted before the push, would refuse it too: the oracle bound is checked first.
    function test_unwind_poolPushedOffOracle_reverts() public {
        openRescuable(borrower, START_HF);
        uint256 amount = keeperRepay(borrower, TARGET_HF, SLIPPAGE_BPS, ut.deepFee);
        uint256 maxSold = keeperMaxSold(amount, ut.deepFee);

        uint160 pushedTo = pushWethPriceDown(uniPool, 300);
        (uint160 sqrtPriceX96,,,,,,) = uniPool.slot0();
        assertEq(sqrtPriceX96, pushedTo, "the pool moved");

        Reads memory before = read(borrower, uniPool);
        vm.prank(rescuer);
        vm.expectPartialRevert(LeveeUnwind.SlippageExceeded.selector);
        helper.unwind(borrower, address(weth), amount, ut.deepFee, maxSold);
        assertNothingMoved(before);
    }

    // ---- pools -----------------------------------------------------------------------------

    /// A real pool, created on the fork by the factory owner, at the oracle price, with too
    /// little USDC for the amount. Uniswap fills what it can and stops at the price limit.
    function test_unwind_poolTooThin_reverts() public {
        openPosition(borrower, COLLATERAL, START_HF);
        uint256 amount = keeperRepay(borrower, TARGET_HF, SLIPPAGE_BPS, 2500);
        IUniswapV3Pool thin = createThinPool(2500, 50, amount / 10);
        authorizeAndApprove(borrower, SLIPPAGE_BPS, TRIGGER_HF, TARGET_HF, COLLATERAL, 2500);

        Reads memory before = read(borrower, thin);
        vm.prank(rescuer);
        vm.expectPartialRevert(LeveeUnwind.PartialFill.selector);
        helper.unwind(borrower, address(weth), amount, 2500, NO_CAP);
        assertNothingMoved(before);
        assertEq(usdc.balanceOf(address(thin)), before.poolUsdc, "thin pool paid nothing out");
    }

    // ---- the borrower's limits ----------------------------------------------------------

    function test_unwind_allowanceTooSmall_reverts() public {
        openPosition(borrower, COLLATERAL, START_HF);
        uint256 amount = keeperRepay(borrower, TARGET_HF, SLIPPAGE_BPS, ut.deepFee);
        // A tenth of what the sale needs.
        uint256 allowance = maxCollateralIn(amount, SLIPPAGE_BPS) / 10;
        authorizeAndApprove(borrower, SLIPPAGE_BPS, TRIGGER_HF, TARGET_HF, allowance);

        Reads memory before = read(borrower, uniPool);
        vm.prank(rescuer);
        vm.expectRevert();
        helper.unwind(borrower, address(weth), amount, ut.deepFee, NO_CAP);
        assertNothingMoved(before);
    }

    /// Most of the position is backed by a second collateral, so the WETH the sale needs is
    /// more than the borrower has.
    function test_unwind_collateralBalanceTooSmall_reverts() public {
        uint256 wethSupplied = 1 ether;
        openTwoCollateralPosition(borrower, wethSupplied, 20_000e8, START_HF);
        authorizeAndApprove(borrower, SLIPPAGE_BPS, TRIGGER_HF, TARGET_HF, type(uint256).max);
        uint256 amount = keeperRepay(borrower, TARGET_HF, SLIPPAGE_BPS, ut.deepFee);
        assertGt(maxCollateralIn(amount, 0), aWeth.balanceOf(borrower), "the sale needs more WETH than there is");

        Reads memory before = read(borrower, uniPool);
        vm.prank(rescuer);
        vm.expectRevert();
        helper.unwind(borrower, address(weth), amount, ut.deepFee, NO_CAP);
        assertNothingMoved(before);
    }

    // ---- callbacks and re-entry ----------------------------------------------------------

    function test_callback_fromFakePool_reverts() public {
        openRescuable(borrower, START_HF);
        FakePool fake = new FakePool();
        // Data that, if accepted, would repay nothing and pull the borrower's aWETH.
        bytes memory data = callbackData(borrower);

        Reads memory before = read(borrower, uniPool);
        vm.expectRevert(LeveeUnwind.UnexpectedCallback.selector);
        fake.callBack(helper, int256(1 ether), -int256(1e6), data);
        assertNothingMoved(before);
    }

    function test_callback_fromTheRealPoolWithNoUnwind_reverts() public {
        openRescuable(borrower, START_HF);
        bytes memory data = callbackData(borrower);

        Reads memory before = read(borrower, uniPool);
        vm.prank(address(uniPool));
        vm.expectRevert(LeveeUnwind.UnexpectedCallback.selector);
        helper.uniswapV3SwapCallback(int256(1 ether), -int256(1e6), data);
        assertNothingMoved(before);
    }

    /// The collateral token's own code re-enters while Aave pays the pool, the one point in
    /// an unwind where code outside Aave, Uniswap and USDC runs. It tries to unwind a second
    /// borrower who authorized it as their rescuer, then calls the swap callback.
    function test_reentrancy_throughCollateralToken_isRefused() public {
        openRescuable(borrower, START_HF);
        address victim = makeAddr("victim");
        openPosition(victim, COLLATERAL, START_HF);
        vm.startPrank(victim);
        helper.authorize(address(weth), SLIPPAGE_BPS, TRIGGER_HF, TARGET_HF, address(weth), ut.deepFee);
        aWeth.approve(address(helper), COLLATERAL);
        vm.stopPrank();
        uint256 victimAmount = keeperRepay(victim, TARGET_HF, SLIPPAGE_BPS, ut.deepFee);
        uint256 amount = keeperRepay(borrower, TARGET_HF, SLIPPAGE_BPS, ut.deepFee);

        address original = makeAddr("original WETH code");
        vm.etch(original, address(weth).code);
        ReentrantToken attacker =
            new ReentrantToken(original, address(helper), address(uniPool), victim, ut.deepFee, victimAmount);
        vm.etch(address(weth), address(attacker).code);
        IReentrantToken(address(weth)).arm();

        Reads memory victimBefore = read(victim, uniPool);
        unwindAndCheck(borrower, amount, ut.deepFee);

        (bytes32 unwindResult, bytes32 callbackResult) = IReentrantToken(address(weth)).results();
        assertEq(unwindResult, bytes32(LeveeUnwind.Reentrancy.selector), "re-entering unwind");
        assertEq(callbackResult, bytes32(LeveeUnwind.UnexpectedCallback.selector), "re-entering the callback");
        assertEq(vDebtUsdc.balanceOf(victim), victimBefore.debt, "victim debt moved");
        assertEq(aWeth.balanceOf(victim), victimBefore.aWeth, "victim collateral moved");
    }

    // ---- L-2: Aave reserve state ------------------------------------------------------------

    /// Governance freezes reserves in market stress, when an unwind is most needed, and Aave
    /// still lets frozen collateral leave. Before the fix the helper refused it.
    function test_unwind_frozenCollateral_isSold() public {
        openRescuable(borrower, START_HF);
        uint256 amount = keeperRepay(borrower, TARGET_HF, SLIPPAGE_BPS, ut.deepFee);
        asPoolAdmin().setReserveFreeze(address(weth), true);
        assertEq((IPoolCollateral(address(pool)).getConfiguration(address(weth)) >> 57) & 1, 1, "WETH is frozen");

        Outcome memory o = unwindAndCheck(borrower, amount, ut.deepFee);
        assertGe(o.afterwards.healthFactor, TARGET_HF, "reaches the target");
        console2.log(
            target.name, "frozen WETH LTV", IPoolCollateral(address(pool)).getConfiguration(address(weth)) & 0xffff
        );
    }

    function test_unwind_pausedCollateral_reverts() public {
        openRescuable(borrower, START_HF);
        uint256 amount = keeperRepay(borrower, TARGET_HF, SLIPPAGE_BPS, ut.deepFee);
        asPoolAdmin().setReservePause(address(weth), true);

        Reads memory before = read(borrower, uniPool);
        vm.prank(rescuer);
        vm.expectRevert(abi.encodeWithSelector(LeveeUnwind.CollateralUnavailable.selector, address(weth)));
        helper.unwind(borrower, address(weth), amount, ut.deepFee, NO_CAP);
        assertNothingMoved(before);
    }

    /// Aave refuses to deactivate a reserve that has suppliers, so the test clears WETH's
    /// active bit in the Pool's storage, as the configuration would read once deactivated.
    function test_unwind_inactiveCollateral_reverts() public {
        openRescuable(borrower, START_HF);
        uint256 amount = keeperRepay(borrower, TARGET_HF, SLIPPAGE_BPS, ut.deepFee);
        uint256 config = IPoolCollateral(address(pool)).getConfiguration(address(weth));
        writeReserveConfiguration(address(weth), config & ~(uint256(1) << 56));

        Reads memory before = read(borrower, uniPool);
        vm.prank(rescuer);
        vm.expectRevert(abi.encodeWithSelector(LeveeUnwind.CollateralUnavailable.selector, address(weth)));
        helper.unwind(borrower, address(weth), amount, ut.deepFee, NO_CAP);
        assertNothingMoved(before);
    }

    /// The auditor's test_F3. Another collateral in the account at LTV 0, which from Aave
    /// v3.6 every frozen reserve is, makes Aave refuse to move any collateral with a
    /// non-zero LTV first. The helper cannot change that, so the keeper reads the account
    /// and records `ltv_zero_collateral` instead of sending this transaction.
    function test_unwind_otherCollateralAtLtvZero_isRefusedByAave() public {
        openTwoCollateralPosition(borrower, COLLATERAL, 1_000e8, START_HF);
        authorizeAndApprove(borrower, SLIPPAGE_BPS, TRIGGER_HF, TARGET_HF, type(uint256).max);
        uint256 amount = keeperRepay(borrower, TARGET_HF, SLIPPAGE_BPS, ut.deepFee);

        // Works before the other collateral is frozen.
        uint256 snapshot = vm.snapshotState();
        unwindAs(rescuer, borrower, amount, ut.deepFee, NO_CAP);
        vm.revertToState(snapshot);

        address second = ut.secondCollateral;
        asPoolAdmin().setReserveFreeze(second, true);
        uint256 config = IPoolCollateral(address(pool)).getConfiguration(second);
        if (config & 0xffff != 0) {
            // Before v3.6 a freeze leaves the LTV alone, so set it to zero as governance would.
            asPoolAdmin().configureReserveAsCollateral(second, 0, (config >> 16) & 0xffff, (config >> 32) & 0xffff);
        }
        assertEq(IPoolCollateral(address(pool)).getConfiguration(second) & 0xffff, 0, "second collateral at LTV 0");

        Reads memory before = read(borrower, uniPool);
        vm.prank(rescuer);
        vm.expectRevert(IAaveErrors.LtvValidationFailed.selector);
        helper.unwind(borrower, address(weth), amount, ut.deepFee, NO_CAP);
        assertNothingMoved(before);
    }

    // ---- I-3: the price oracle sentinel ----------------------------------------------------

    /// None of these markets has a sentinel set, so the provider's owner sets a mock one
    /// on the fork, after the helper was deployed: the helper reads it on every call.
    function test_unwind_sentinelRefusing_reverts_thenAllows() public {
        openRescuable(borrower, START_HF);
        uint256 amount = keeperRepay(borrower, TARGET_HF, SLIPPAGE_BPS, ut.deepFee);
        MockSentinel sentinel = setSentinel();

        sentinel.set(false);
        Reads memory before = read(borrower, uniPool);
        vm.prank(rescuer);
        vm.expectRevert(abi.encodeWithSelector(LeveeUnwind.PriceOracleSentinelRefused.selector, address(sentinel)));
        helper.unwind(borrower, address(weth), amount, ut.deepFee, NO_CAP);
        assertNothingMoved(before);

        sentinel.set(true);
        Outcome memory o = unwindAndCheck(borrower, amount, ut.deepFee);
        assertGe(o.afterwards.healthFactor, TARGET_HF, "reaches the target once the sentinel allows it");
    }

    // ---- isolation mode --------------------------------------------------------------------

    /// Isolation mode exists up to Aave v3.6, Pool revision 10, and was removed in v3.7,
    /// revision 11. No reserve on these forks has a debt ceiling, so where it exists the
    /// test gives WETH one by writing the Pool's storage, as governance would with
    /// `setDebtCeiling` on a reserve without suppliers.
    function test_unwind_isolationModeBorrower() public {
        if (pool.POOL_REVISION() >= 11) {
            console2.log(target.name, "has no isolation mode: Aave v3.7 removed it at Pool revision 11");
            vm.skip(true);
        }
        setDebtCeiling(address(weth), 100_000_000_00); // 100M USD, in Aave's 2 decimals

        deal(address(weth), borrower, COLLATERAL);
        vm.startPrank(borrower);
        weth.approve(address(pool), COLLATERAL);
        IPoolCollateral(address(pool)).supply(address(weth), COLLATERAL, borrower, 0);
        // Aave does not enable an isolated asset as collateral on its own.
        IPoolCollateral(address(pool)).setUserUseReserveAsCollateral(address(weth), true);
        (uint256 collateralBase,,, uint256 threshold,,) = pool.getUserAccountData(borrower);
        uint256 debt =
            collateralBase * threshold * WAD / BPS / START_HF * USDC_UNIT / oracle.getAssetPrice(address(usdc));
        pool.borrow(address(usdc), debt, VARIABLE_RATE, 0, borrower);
        vm.stopPrank();
        authorizeAndApprove(borrower, SLIPPAGE_BPS, TRIGGER_HF, TARGET_HF, COLLATERAL);

        uint256 isolatedDebtBefore = aaveReserve(address(weth)).isolationModeTotalDebt;
        assertEq(isolatedDebtBefore, debt / 1e4, "borrow counted against the debt ceiling");

        uint256 amount = keeperRepay(borrower, TARGET_HF, SLIPPAGE_BPS, ut.deepFee);
        Outcome memory o = unwindAndCheck(borrower, amount, ut.deepFee);
        assertEq(
            aaveReserve(address(weth)).isolationModeTotalDebt,
            isolatedDebtBefore - o.repaid / 1e4,
            "repay released the debt ceiling"
        );
    }

    // ---- recorded behaviour ------------------------------------------------------------------

    /// I-2, the auditor's test_F4. aTokens anyone donates to the helper go to the Uniswap
    /// pool with the next unwind, because the helper withdraws its whole balance so that no
    /// scaled dust stays. Nobody can take them back, and the borrower pays only their sale.
    function test_unwind_donatedATokens_goToThePool() public {
        openRescuable(borrower, START_HF);
        uint256 amount = keeperRepay(borrower, TARGET_HF, SLIPPAGE_BPS, ut.deepFee);
        address donor = makeAddr("donor");
        deal(address(weth), donor, 1 ether);
        vm.startPrank(donor);
        weth.approve(address(pool), 1 ether);
        IPoolCollateral(address(pool)).supply(address(weth), 1 ether, address(helper), 0);
        vm.stopPrank();
        assertApproxEqAbs(aWeth.balanceOf(address(helper)), 1 ether, ATOKEN_ROUNDING, "donation landed");

        uint256 poolWethBefore = weth.balanceOf(address(uniPool));
        uint256 borrowerAWethBefore = aWeth.balanceOf(borrower);
        (, uint256 sold,) = unwindAs(rescuer, borrower, amount, ut.deepFee, keeperMaxSold(amount, ut.deepFee));
        assertApproxEqAbs(weth.balanceOf(address(uniPool)) - poolWethBefore, sold + 1 ether, 4, "donation went on");
        assertApproxEqAbs(borrowerAWethBefore - aWeth.balanceOf(borrower), sold, ATOKEN_ROUNDING, "borrower paid");
        assertHelperClean();
    }

    /// The auditor's sequence test. A hostile rescuer splitting the keeper's amount into
    /// small unwinds stops at the trigger, short of what one honest unwind repays.
    function test_unwind_manySmallUnwinds_stopAtTheTrigger() public {
        openRescuable(borrower, START_HF);
        uint256 honest = keeperRepay(borrower, TARGET_HF, SLIPPAGE_BPS, ut.deepFee);
        uint256 step = honest / 20;
        uint256 total;
        uint256 count;
        while (healthFactorOf(borrower) < TRIGGER_HF) {
            (uint256 repaid,,) = unwindAs(rescuer, borrower, step, ut.deepFee, keeperMaxSold(step, ut.deepFee));
            total += repaid;
            count++;
        }
        console2.log(target.name, "small unwinds before the trigger stopped them", count);
        assertLt(total, honest, "the run repaid less than one honest unwind");
        vm.prank(rescuer);
        vm.expectPartialRevert(LeveeUnwind.AboveTrigger.selector);
        helper.unwind(borrower, address(weth), step, ut.deepFee, NO_CAP);
    }

    // ---- fuzz ------------------------------------------------------------------------------

    function testFuzz_unwind_amountAndSlippage(uint256 amountSeed, uint16 slippage) public {
        slippage = uint16(bound(slippage, 100, helper.MAX_SLIPPAGE_BPS()));
        openPosition(borrower, COLLATERAL, START_HF);
        authorizeAndApprove(borrower, slippage, TRIGGER_HF, TARGET_HF, COLLATERAL);
        uint256 honest = keeperRepay(borrower, TARGET_HF, slippage, ut.deepFee);
        uint256 amount = bound(amountSeed, USDC_UNIT, honest);

        unwindAndCheck(borrower, amount, ut.deepFee, slippage, TARGET_HF);
    }

    function testFuzz_unwind_triggerAndTarget(uint64 trigger, uint64 targetHf) public {
        trigger = uint64(bound(trigger, 1.06e18, 2e18));
        targetHf = uint64(bound(targetHf, uint256(trigger) + 0.005e18, helper.MAX_TARGET_HF()));
        openPosition(borrower, COLLATERAL, trigger - 0.01e18);
        authorizeAndApprove(borrower, SLIPPAGE_BPS, trigger, targetHf, COLLATERAL);

        uint256 amount = keeperRepay(borrower, targetHf, SLIPPAGE_BPS, ut.deepFee);
        Outcome memory o = unwindAndCheck(borrower, amount, ut.deepFee, SLIPPAGE_BPS, targetHf);
        assertGe(o.afterwards.healthFactor, targetHf, "reaches the target");
    }

    // ---- constructor -----------------------------------------------------------------------

    function test_constructor_rejectsWrongArguments() public {
        UnwindArgs memory args = Deployments.unwindArgs(block.chainid);
        vm.expectRevert(LeveeUnwind.ZeroAddress.selector);
        new LeveeUnwind(address(0), args.usdc, args.uniswapV3Factory);
        vm.expectRevert(LeveeUnwind.NotUsdcReserve.selector);
        new LeveeUnwind(args.addressesProvider, makeAddr("not a reserve"), args.uniswapV3Factory);
        vm.expectRevert();
        new LeveeUnwind(args.addressesProvider, args.usdc, address(pool));
    }

    // ---- helpers ---------------------------------------------------------------------------

    function assertNothingMoved(Reads memory before) internal view {
        assertEq(vDebtUsdc.balanceOf(borrower), before.debt, "debt moved");
        assertEq(aWeth.balanceOf(borrower), before.aWeth, "collateral moved");
        assertEq(aWeth.allowance(borrower, address(helper)), before.aWethAllowance, "allowance moved");
        assertEq(weth.balanceOf(borrower), before.walletWeth, "wallet WETH moved");
        assertEq(usdc.balanceOf(borrower), before.walletUsdc, "wallet USDC moved");
        assertHelperClean();
    }

    /// Callback data as `unwind` encodes it, for a call that would repay nothing.
    function callbackData(address user) internal view returns (bytes memory) {
        return abi.encode(
            user, address(weth), address(aWeth), address(pool), uint256(1e6), type(uint256).max, type(uint256).max, true
        );
    }

    /// With no cap from the rescuer, as a stolen keeper key could send it, so that only the
    /// post-check decides. Anything it refuses must be an OverSold.
    function unwindWouldPass(address user, uint256 amount) internal returns (bool passed) {
        uint256 snapshot = vm.snapshotState();
        vm.prank(rescuer);
        try helper.unwind(user, address(weth), amount, ut.deepFee, NO_CAP) {
            passed = true;
        } catch (bytes memory err) {
            // A revert selector is the first four bytes of the data.
            // forge-lint: disable-next-line(unsafe-typecast)
            assertEq(bytes4(err), LeveeUnwind.OverSold.selector, "refused by something other than the post-check");
        }
        vm.revertToState(snapshot);
    }

    /// The largest sale, in bps of the keeper's own amount, that the post-check lets
    /// through for `user` as they stand, found by bisection to 1 bp.
    function overSaleHeadroomBps(address user, uint64 targetHf, string memory label)
        internal
        returns (uint256 allowedBps)
    {
        uint256 honest = keeperRepay(user, targetHf, SLIPPAGE_BPS, ut.deepFee);
        allowedBps = BPS;
        uint256 refusedBps = 20_000;
        assertTrue(unwindWouldPass(user, honest), "the keeper's amount passes");
        assertFalse(unwindWouldPass(user, honest * refusedBps / BPS), "twice the amount is refused");
        while (refusedBps - allowedBps > 1) {
            uint256 mid = (allowedBps + refusedBps) / 2;
            if (unwindWouldPass(user, honest * mid / BPS)) allowedBps = mid;
            else refusedBps = mid;
        }
        console2.log(string.concat(target.name, " ", label, ": largest sale allowed, bps of the keeper's amount"));
        console2.log("  ", allowedBps);
    }

    /// Sells WETH into `uni` until its price is `bps` lower, as a whale or a sandwich would.
    function pushWethPriceDown(IUniswapV3Pool uni, uint256 bps) internal returns (uint160 limit) {
        return pushWethPriceDownTenths(new PoolSwapper(), uni, bps * 10);
    }

    /// The same in tenths of a basis point, from a given swapper. `tenthsBps` above zero.
    function pushWethPriceDownTenths(PoolSwapper whale, IUniswapV3Pool uni, uint256 tenthsBps)
        internal
        returns (uint160 limit)
    {
        deal(address(weth), address(whale), 10_000_000 ether);
        (uint160 sqrtPriceX96,,,,,,) = uni.slot0();
        bool wethIsToken0 = address(weth) < address(usdc);
        // Price is token1 per token0, so a cheaper WETH is a lower price when WETH is token0.
        uint256 sqrtFactor = sqrt((100_000 - tenthsBps) * 1e36 / 100_000); // 1e18-scaled sqrt of the move
        limit = SafeCast.toUint160(
            wethIsToken0 ? uint256(sqrtPriceX96) * sqrtFactor / 1e18 : uint256(sqrtPriceX96) * 1e18 / sqrtFactor
        );
        whale.swap(uni, wethIsToken0, SafeCast.toInt256(10_000_000 ether), limit);
    }

    struct Sandwich {
        uint24 fee;
        uint256 amount;
        uint256 maxSold;
        uint256 honestCost100;
        uint256 cappedPushTenths;
        uint256 cappedSold;
        uint256 cappedCost100;
        int256 cappedBestProfit;
        uint256 uncappedPushTenths;
        uint256 uncappedCost100;
        int256 uncappedBestProfit;
    }

    /// The pool the auditor sandwiched: 0.05% where the pair has one, as on Base and
    /// Arbitrum, where a sandwich costs the searcher least. Otherwise the deepest.
    function cheapestFee() internal view returns (uint24) {
        if (ut.deepFee == 500 || ut.otherFee != 500) return ut.deepFee;
        return ut.otherFee;
    }

    /// The auditor's sandwich, run twice from the same state: with the keeper's cap,
    /// quoted before the searcher moves, and with no cap, as a stolen keeper key could
    /// send. Each time at the largest front-run push that still lets the unwind through,
    /// and over a grid of pushes up to it for the searcher's best profit.
    function sandwich(uint256 collateral) internal returns (Sandwich memory sw) {
        sw.fee = cheapestFee();
        IUniswapV3Pool uni = IUniswapV3Pool(uniFactory.getPool(address(weth), address(usdc), sw.fee));
        openPosition(borrower, collateral, START_HF);
        authorizeAndApprove(borrower, SLIPPAGE_BPS, TRIGGER_HF, TARGET_HF, type(uint256).max, sw.fee);
        sw.amount = keeperRepay(borrower, TARGET_HF, SLIPPAGE_BPS, sw.fee);
        uint256 honestSold = quoteSale(sw.amount, sw.fee);
        sw.maxSold = honestSold * (BPS + QUOTE_TOLERANCE_BPS) / BPS;
        sw.honestCost100 = costAgainstOracle100(sw.amount, honestSold);

        uint256 hi = uint256(SLIPPAGE_BPS) * 10;
        sw.cappedPushTenths = largestPush(uni, sw.fee, sw.amount, sw.maxSold, hi);
        (sw.cappedSold,) = runSandwich(uni, sw.fee, sw.amount, sw.maxSold, sw.cappedPushTenths);
        sw.cappedCost100 = costAgainstOracle100(sw.amount, sw.cappedSold);
        sw.cappedBestProfit = bestProfit(uni, sw.fee, sw.amount, sw.maxSold, sw.cappedPushTenths);

        sw.uncappedPushTenths = largestPush(uni, sw.fee, sw.amount, NO_CAP, hi);
        (uint256 uncappedSold,) = runSandwich(uni, sw.fee, sw.amount, NO_CAP, sw.uncappedPushTenths);
        sw.uncappedCost100 = costAgainstOracle100(sw.amount, uncappedSold);
        sw.uncappedBestProfit = bestProfit(uni, sw.fee, sw.amount, NO_CAP, sw.uncappedPushTenths);

        console2.log(string.concat(target.name, " sandwich, WETH collateral"), collateral / 1e18);
        console2.log("  pool fee", sw.fee);
        console2.log("  repaid USDC", sw.amount / USDC_UNIT);
        console2.log("  honest cost against the oracle, 1/100 bp", sw.honestCost100);
        console2.log("  with maxSold: largest push, tenths of a bp", sw.cappedPushTenths);
        console2.log("  with maxSold: borrower cost there, 1/100 bp", sw.cappedCost100);
        console2.log("  with maxSold: best searcher profit, USD 8dp", sw.cappedBestProfit);
        console2.log("  without: largest push, tenths of a bp", sw.uncappedPushTenths);
        console2.log("  without: borrower cost there, 1/100 bp", sw.uncappedCost100);
        console2.log("  without: best searcher profit, USD 8dp", sw.uncappedBestProfit);
    }

    /// Largest front-run push, in tenths of a bp, below `hi`, that still lets the unwind pass.
    function largestPush(IUniswapV3Pool uni, uint24 fee, uint256 amount, uint256 maxSold, uint256 hi)
        internal
        returns (uint256 lo)
    {
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            uint256 snapshot = vm.snapshotState();
            pushWethPriceDownTenths(new PoolSwapper(), uni, mid);
            vm.prank(rescuer);
            bool ok;
            try helper.unwind(borrower, address(weth), amount, fee, maxSold) {
                ok = true;
            } catch {}
            vm.revertToState(snapshot);
            if (ok) lo = mid;
            else hi = mid;
        }
    }

    /// The searcher's best profit over ten pushes up to `maxPush`.
    function bestProfit(IUniswapV3Pool uni, uint24 fee, uint256 amount, uint256 maxSold, uint256 maxPush)
        internal
        returns (int256 best)
    {
        best = type(int256).min;
        for (uint256 i = 1; i <= 10; i++) {
            (, int256 profit) = runSandwich(uni, fee, amount, maxSold, maxPush * i / 10);
            if (profit > best) best = profit;
        }
    }

    /// Front-run, unwind, back-run with every USDC the front-run got. Reverts the state.
    function runSandwich(IUniswapV3Pool uni, uint24 fee, uint256 amount, uint256 maxSold, uint256 pushTenths)
        internal
        returns (uint256 sold, int256 profit)
    {
        uint256 snapshot = vm.snapshotState();
        PoolSwapper searcher = new PoolSwapper();
        bool wethIsToken0 = address(weth) < address(usdc);
        uint256 wethStart = 10_000_000 ether;
        deal(address(weth), address(searcher), wethStart);
        if (pushTenths > 0) pushWethPriceDownTenths(searcher, uni, pushTenths);
        uint256 usdcGot = usdc.balanceOf(address(searcher));
        vm.prank(rescuer);
        (, sold) = helper.unwind(borrower, address(weth), amount, fee, maxSold);
        if (usdcGot > 0) {
            searcher.swap(uni, !wethIsToken0, SafeCast.toInt256(usdcGot), wethIsToken0 ? MAX_SQRT : MIN_SQRT);
        }
        int256 wethDelta = SafeCast.toInt256(weth.balanceOf(address(searcher))) - SafeCast.toInt256(wethStart);
        int256 usdcDelta = SafeCast.toInt256(usdc.balanceOf(address(searcher)));
        profit = wethDelta * SafeCast.toInt256(oracle.getAssetPrice(address(weth))) / 1e18 + usdcDelta
            * SafeCast.toInt256(oracle.getAssetPrice(address(usdc))) / SafeCast.toInt256(USDC_UNIT);
        vm.revertToState(snapshot);
    }

    /// What the sale cost against Aave's oracle, in hundredths of a basis point.
    function costAgainstOracle100(uint256 repaid, uint256 sold) internal view returns (uint256) {
        uint256 soldBase = sold * oracle.getAssetPrice(address(weth)) / 1e18;
        uint256 repaidBase = repaid * oracle.getAssetPrice(address(usdc)) / USDC_UNIT;
        return soldBase > repaidBase ? (soldBase - repaidBase) * 1e6 / repaidBase : 0;
    }

    function createThinPool(uint24 fee, int24 tickSpacing, uint256 usdcDepth) internal returns (IUniswapV3Pool thin) {
        IUniswapV3FactoryOwner factory = IUniswapV3FactoryOwner(address(uniFactory));
        assertEq(uniFactory.feeAmountTickSpacing(fee), 0, "fee tier already enabled");
        vm.prank(factory.owner());
        factory.enableFeeAmount(fee, tickSpacing);
        thin = IUniswapV3Pool(factory.createPool(address(weth), address(usdc), fee));

        (address token0, address token1) =
            address(weth) < address(usdc) ? (address(weth), address(usdc)) : (address(usdc), address(weth));
        uint256 unit0 = token0 == address(weth) ? 1e18 : USDC_UNIT;
        uint256 unit1 = token1 == address(weth) ? 1e18 : USDC_UNIT;
        IUniswapV3PoolActions(address(thin))
            .initialize(
                TestnetPoolMath.oracleSqrtPriceX96(
                    oracle.getAssetPrice(token0), unit0, oracle.getAssetPrice(token1), unit1
                )
            );
        (, int24 tick,,,,,) = thin.slot0();
        int24 lower = TestnetPoolMath.floorToSpacing(tick, tickSpacing) - tickSpacing;
        int24 upper = TestnetPoolMath.floorToSpacing(tick, tickSpacing) + 2 * tickSpacing;

        PoolMinter minter = new PoolMinter();
        deal(address(weth), address(minter), 1_000 ether);
        deal(address(usdc), address(minter), usdcDepth);
        // Liquidity sized so the USDC side holds about `usdcDepth`: halve until it fits.
        uint128 liquidity = 1e18;
        while (true) {
            uint256 snapshot = vm.snapshotState();
            try minter.mint(thin, lower, upper, liquidity) {
                vm.revertToState(snapshot);
                break;
            } catch {
                vm.revertToState(snapshot);
                liquidity /= 2;
                assertGt(liquidity, 0, "could not mint a thin position");
            }
        }
        minter.mint(thin, lower, upper, liquidity);
        assertLe(usdc.balanceOf(address(thin)), usdcDepth, "thin pool holds too much USDC");
    }

    function openTwoCollateralPosition(address user, uint256 wethAmount, uint256 secondValueBase, uint256 healthFactor)
        internal
    {
        IERC20Like second = IERC20Like(ut.secondCollateral);
        uint256 secondUnit = 10 ** ((aaveReserve(address(second)).configuration >> 48) & 0xff);
        uint256 secondAmount = secondValueBase * secondUnit / oracle.getAssetPrice(address(second));
        deal(address(second), user, secondAmount);
        deal(address(weth), user, wethAmount);

        vm.startPrank(user);
        second.approve(address(pool), secondAmount);
        IPoolCollateral(address(pool)).supply(address(second), secondAmount, user, 0);
        weth.approve(address(pool), wethAmount);
        IPoolCollateral(address(pool)).supply(address(weth), wethAmount, user, 0);
        (uint256 collateralBase,,, uint256 threshold,,) = pool.getUserAccountData(user);
        uint256 debt =
            collateralBase * threshold * WAD / BPS / healthFactor * USDC_UNIT / oracle.getAssetPrice(address(usdc));
        pool.borrow(address(usdc), debt, VARIABLE_RATE, 0, user);
        vm.stopPrank();
        // Aave truncates the averaged liquidation threshold to whole basis points.
        assertApproxEqRel(healthFactorOf(user), healthFactor, 1e15, "two-collateral position health factor");
    }

    /// A WETH position in an eMode category the test creates as pool admin: WETH
    /// collateral, USDC borrowable, LTV 94%, liquidation threshold 95%.
    function openEModePosition(address user, uint256 wethAmount, uint256 healthFactor) internal {
        uint8 category = createTestEMode();
        deal(address(weth), user, wethAmount);
        vm.startPrank(user);
        weth.approve(address(pool), wethAmount);
        IPoolCollateral(address(pool)).supply(address(weth), wethAmount, user, 0);
        IPoolEMode(address(pool)).setUserEMode(category);
        (uint256 collateralBase,,, uint256 threshold,,) = pool.getUserAccountData(user);
        assertEq(threshold, 9500, "the account uses the eMode threshold");
        uint256 debt =
            collateralBase * threshold * WAD / BPS / healthFactor * USDC_UNIT / oracle.getAssetPrice(address(usdc));
        pool.borrow(address(usdc), debt, VARIABLE_RATE, 0, user);
        vm.stopPrank();
        assertApproxEqRel(healthFactorOf(user), healthFactor, 1e12, "eMode position health factor");
    }

    /// Creates eMode category 200 as pool admin: WETH collateral, USDC borrowable, LTV 94%,
    /// liquidation threshold 95%, bonus 1%.
    function createTestEMode() internal returns (uint8 category) {
        category = 200;
        assertEq(
            IPoolEMode(address(pool)).getEModeCategoryCollateralConfig(category).liquidationThreshold,
            0,
            "category in use"
        );
        address admin = poolAdmin();
        IPoolConfigurator configurator =
            IPoolConfigurator(IAddressesProviderAdmin(pool.ADDRESSES_PROVIDER()).getPoolConfigurator());
        vm.startPrank(admin);
        // Aave v3.7 added an `isolated` flag to the end of the call; older Pools take five.
        (bool withIsolatedFlag,) = address(configurator)
            .call(
                abi.encodeWithSignature(
                    "setEModeCategory(uint8,uint16,uint16,uint16,string,bool)",
                    category,
                    uint16(9400),
                    uint16(9500),
                    uint16(10100),
                    "test WETH USDC 95",
                    false
                )
            );
        if (!withIsolatedFlag) configurator.setEModeCategory(category, 9400, 9500, 10100, "test WETH USDC 95");
        configurator.setAssetCollateralInEMode(address(weth), category, true);
        configurator.setAssetBorrowableInEMode(address(usdc), category, true);
        vm.stopPrank();
    }

    /// Sets a mock price oracle sentinel as the PoolAddressesProvider's owner.
    function setSentinel() internal returns (MockSentinel sentinel) {
        IPoolAddressesProvider provider = IPoolAddressesProvider(pool.ADDRESSES_PROVIDER());
        assertEq(provider.getPriceOracleSentinel(), address(0), "the fork already has a sentinel");
        sentinel = new MockSentinel();
        vm.prank(provider.owner());
        provider.setPriceOracleSentinel(address(sentinel));
        assertEq(provider.getPriceOracleSentinel(), address(sentinel), "sentinel set");
    }

    /// Grants a fresh address the pool admin role from the fork's ACL admin.
    function poolAdmin() internal returns (address admin) {
        IAddressesProviderAdmin provider = IAddressesProviderAdmin(pool.ADDRESSES_PROVIDER());
        admin = makeAddr("pool admin");
        IACLManager acl = IACLManager(provider.getACLManager());
        vm.prank(provider.getACLAdmin());
        acl.addPoolAdmin(admin);
    }

    /// Grants the pool admin role, and pranks it for the next call on the configurator.
    function asPoolAdmin() internal returns (IPoolConfigurator configurator) {
        address admin = poolAdmin();
        configurator = IPoolConfigurator(IAddressesProviderAdmin(pool.ADDRESSES_PROVIDER()).getPoolConfigurator());
        vm.prank(admin);
    }

    /// Writes a reserve's configuration word. The slot of `_reserves[asset]` is found by
    /// matching `getConfiguration` rather than assumed.
    function writeReserveConfiguration(address asset, uint256 newConfig) internal {
        uint256 config = IPoolCollateral(address(pool)).getConfiguration(asset);
        bytes32 slot;
        for (uint256 i = 0; i < 128; i++) {
            bytes32 candidate = keccak256(abi.encode(asset, i));
            if (uint256(vm.load(address(pool), candidate)) == config) {
                slot = candidate;
                break;
            }
        }
        assertTrue(slot != bytes32(0), "reserve configuration slot not found");
        vm.store(address(pool), slot, bytes32(newConfig));
        assertEq(IPoolCollateral(address(pool)).getConfiguration(asset), newConfig, "configuration written");
    }

    function setDebtCeiling(address asset, uint256 ceiling) internal {
        uint256 config = IPoolCollateral(address(pool)).getConfiguration(asset);
        uint256 mask = ((uint256(1) << 40) - 1) << 212;
        writeReserveConfiguration(asset, (config & ~mask) | (ceiling << 212));
    }

    function sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        y = x;
        uint256 z = (x + 1) / 2;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}
