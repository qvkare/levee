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
import {IERC20Like} from "./AaveInterfaces.sol";
import {
    FakePool,
    IReentrantToken,
    IUniswapV3FactoryOwner,
    IUniswapV3PoolActions,
    PoolMinter,
    PoolSwapper,
    ReentrantToken
} from "./UnwindActors.sol";
import {UnwindFork} from "./UnwindFork.sol";

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
