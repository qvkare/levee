// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {console2} from "forge-std/console2.sol";
import {AaveFork, ForkTarget, Targets} from "./lib/AaveFork.sol";
import {IAaveErrors, IAaveOracle, IPoolAddressesProvider} from "./lib/AaveInterfaces.sol";

interface IPoolAddressesProviderData is IPoolAddressesProvider {
    function getPoolDataProvider() external view returns (address);
}

interface IPoolDataProvider {
    function getReserveConfigurationData(address asset)
        external
        view
        returns (
            uint256 decimals,
            uint256 ltv,
            uint256 liquidationThreshold,
            uint256 liquidationBonus,
            uint256 reserveFactor,
            bool usageAsCollateralEnabled,
            bool borrowingEnabled,
            bool stableBorrowRateEnabled,
            bool isActive,
            bool isFrozen
        );

    function getLiquidationProtocolFee(address asset) external view returns (uint256);
}

/// One position, one forced price path, two timelines. The oracle is mocked with
/// vm.mockCall and everything else is the live Aave deployment at the pinned block.
contract BaseCrashTest is AaveFork {
    uint256 internal constant COLLATERAL = 10 ether;
    uint256 internal constant START_HEALTH_FACTOR = 1.5e18;
    uint256 internal constant TRIGGER = 1.25e18;
    uint256 internal constant TARGET = 1.6e18;

    /// 62% of the start price takes a 1.50 position to 0.93, below the 0.95 line at
    /// which Aave lets a liquidator close the whole debt.
    uint256 internal constant CRASH_PRICE_BPS = 6_200;
    uint256 internal constant FULL_LIQUIDATION_HEALTH_FACTOR = 0.95e18;

    struct Timeline {
        uint256 healthFactorAtCrash;
        uint256 collateralLeft;
        uint256 debtLeft;
        uint256 reserveSpent;
        uint256 liquidatorPaid;
        uint256 liquidatorReceived;
        /// Collateral less debt at the crash price, less what the reserve spent.
        uint256 netEquityBase;
    }

    uint256 internal startPrice;
    uint256 internal crashPrice;
    uint256 internal startHealthFactor;

    function forkTarget() internal pure override returns (ForkTarget memory) {
        return Targets.base();
    }

    function setUp() public override {
        super.setUp();
        openPosition(borrower, COLLATERAL, START_HEALTH_FACTOR);
        startPrice = oracle.getAssetPrice(address(weth));
        crashPrice = startPrice * CRASH_PRICE_BPS / BPS;
        startHealthFactor = healthFactorOf(borrower);
    }

    function test_crash_withoutRescue_isLiquidatedAndPaysTheBonus() public {
        Timeline memory t = crashWithoutRescue();

        assertLt(t.collateralLeft, COLLATERAL / 10, "most of the collateral should be gone");
        assertLt(t.debtLeft, DEBT_ROUNDING + 1, "close factor is 100% below 0.95");
        assertEq(t.reserveSpent, 0, "nothing was rescued");
    }

    function test_crash_withRescueAtTrigger_survives() public {
        Timeline memory t = crashWithRescueAtTrigger();

        assertEq(t.collateralLeft, aWeth.balanceOf(borrower), "timeline reports live collateral");
        assertApproxEqAbs(t.collateralLeft, COLLATERAL, 1, "no collateral was lost");
        assertGe(t.healthFactorAtCrash, WAD, "position is not liquidatable after the crash");
    }

    function test_crash_printsTheDifference() public {
        uint256 start = vm.snapshotState();
        Timeline memory unrescued = crashWithoutRescue();

        vm.clearMockedCalls();
        assertTrue(vm.revertToState(start), "could not rewind to the same position");
        assertEq(healthFactorOf(borrower), startHealthFactor, "timelines must start equal");

        Timeline memory rescued = crashWithRescueAtTrigger();

        assertGt(rescued.netEquityBase, unrescued.netEquityBase, "rescue must leave the borrower better off");

        uint256 savedBase = rescued.netEquityBase - unrescued.netEquityBase;
        uint256 usdcPrice = oracle.getAssetPrice(address(usdc));
        uint256 paidValue = unrescued.liquidatorPaid * usdcPrice / USDC_UNIT;
        (,,, uint256 bonus,,,,,,) = dataProvider().getReserveConfigurationData(address(weth));
        // The saving is the bonus on the debt the liquidator closed, nothing else.
        assertApproxEqRel(savedBase, paidValue * (bonus - BPS) / BPS, 1e14, "saving should equal the bonus");

        printDifference(unrescued, rescued, savedBase);
    }

    function crashWithoutRescue() internal returns (Timeline memory t) {
        setWethPrice(crashPrice);
        t.healthFactorAtCrash = healthFactorOf(borrower);
        assertLt(t.healthFactorAtCrash, FULL_LIQUIDATION_HEALTH_FACTOR, "crash should reach full liquidation");

        uint256 collateralBefore = aWeth.balanceOf(borrower);
        uint256 debtBefore = vDebtUsdc.balanceOf(borrower);
        uint256 equityBefore = netEquityBase(0);

        deal(address(usdc), liquidator, debtBefore * 2);
        vm.startPrank(liquidator);
        usdc.approve(address(pool), type(uint256).max);
        pool.liquidationCall(address(weth), address(usdc), borrower, type(uint256).max, false);
        vm.stopPrank();

        t.collateralLeft = aWeth.balanceOf(borrower);
        t.debtLeft = vDebtUsdc.balanceOf(borrower);
        t.liquidatorPaid = debtBefore * 2 - usdc.balanceOf(liquidator);
        t.liquidatorReceived = weth.balanceOf(liquidator);
        t.netEquityBase = netEquityBase(0);

        assertApproxEqAbs(t.liquidatorPaid, debtBefore, DEBT_ROUNDING, "liquidator closed the debt");
        assertLt(t.netEquityBase, equityBefore, "liquidation must cost the borrower equity");

        // The borrower gives up the debt's value plus the bonus. The treasury's cut of
        // the bonus comes out of what the liquidator receives, not out of the borrower.
        uint256 usdcPrice = oracle.getAssetPrice(address(usdc));
        uint256 paidValue = t.liquidatorPaid * usdcPrice / USDC_UNIT;
        uint256 takenValue = (collateralBefore - t.collateralLeft) * crashPrice / 1e18;
        (,,, uint256 bonus,,,,,,) = dataProvider().getReserveConfigurationData(address(weth));
        assertGt(bonus, BPS, "WETH must carry a liquidation bonus");
        assertApproxEqRel(takenValue, paidValue * bonus / BPS, 1e14, "collateral taken is debt plus bonus");

        uint256 protocolFee = dataProvider().getLiquidationProtocolFee(address(weth));
        uint256 receivedValue = t.liquidatorReceived * crashPrice / 1e18;
        uint256 bonusValue = takenValue - paidValue;
        assertApproxEqRel(
            receivedValue,
            takenValue - bonusValue * protocolFee / BPS,
            1e14,
            "liquidator keeps the bonus less the protocol fee"
        );
        assertGt(receivedValue, paidValue, "liquidator must profit");
    }

    function crashWithRescueAtTrigger() internal returns (Timeline memory t) {
        uint256 triggerPrice = startPrice * (TRIGGER - 1e15) / startHealthFactor;
        setWethPrice(triggerPrice);
        uint256 healthAtTrigger = healthFactorOf(borrower);
        assertLt(healthAtTrigger, TRIGGER, "price step should cross the trigger");
        assertApproxEqRel(healthAtTrigger, TRIGGER, 2e15, "price step should stop at the trigger");

        uint256 amount = repayToTarget(borrower, TARGET);
        fundRescuer(rescuer, amount, amount);
        uint256 collateralBefore = aWeth.balanceOf(borrower);

        vm.prank(rescuer);
        pool.repay(address(usdc), amount, VARIABLE_RATE, borrower);

        assertGe(healthFactorOf(borrower), TARGET, "rescue should reach the target");
        assertEq(aWeth.balanceOf(borrower), collateralBefore, "rescue moved collateral");

        setWethPrice(crashPrice);
        t.healthFactorAtCrash = healthFactorOf(borrower);
        assertGt(t.healthFactorAtCrash, WAD, "rescued position should stay healthy");

        deal(address(usdc), liquidator, 100_000e6);
        vm.startPrank(liquidator);
        usdc.approve(address(pool), type(uint256).max);
        vm.expectRevert(IAaveErrors.HealthFactorNotBelowThreshold.selector);
        pool.liquidationCall(address(weth), address(usdc), borrower, type(uint256).max, false);
        vm.stopPrank();

        assertEq(usdc.balanceOf(liquidator), 100_000e6, "liquidator paid nothing");
        assertEq(weth.balanceOf(liquidator), 0, "liquidator took nothing");

        t.collateralLeft = aWeth.balanceOf(borrower);
        t.debtLeft = vDebtUsdc.balanceOf(borrower);
        t.reserveSpent = amount;
        t.netEquityBase = netEquityBase(amount);

        assertEq(t.collateralLeft, collateralBefore, "failed liquidation moved collateral");
    }

    function setWethPrice(uint256 price) internal {
        vm.mockCall(
            address(oracle),
            abi.encodeCall(IAaveOracle.getAssetPrice, (address(weth))),
            abi.encode(price)
        );
        assertEq(oracle.getAssetPrice(address(weth)), price, "oracle mock did not take");
    }

    function netEquityBase(uint256 reserveSpent) internal view returns (uint256) {
        uint256 collateralBase = collateralBaseOf(borrower);
        uint256 debtBase = debtBaseOf(borrower);
        uint256 spentBase = reserveSpent * oracle.getAssetPrice(address(usdc)) / USDC_UNIT;
        return collateralBase - debtBase - spentBase;
    }

    function dataProvider() internal view returns (IPoolDataProvider) {
        return IPoolDataProvider(IPoolAddressesProviderData(pool.ADDRESSES_PROVIDER()).getPoolDataProvider());
    }

    function printDifference(Timeline memory unrescued, Timeline memory rescued, uint256 savedBase)
        internal
        view
    {
        console2.log("== Forced crash on Base at block", target.forkBlock);
        console2.log("WETH price USD", fixedPoint(startPrice, 1e8, 2), "->", fixedPoint(crashPrice, 1e8, 2));
        console2.log("trigger", fixedPoint(TRIGGER, WAD, 2), "target", fixedPoint(TARGET, WAD, 2));
        row("health factor at crash", fixedPoint(unrescued.healthFactorAtCrash, WAD, 4), fixedPoint(rescued.healthFactorAtCrash, WAD, 4));
        row("liquidated", "yes", "no");
        row("WETH collateral left", fixedPoint(unrescued.collateralLeft, 1e18, 4), fixedPoint(rescued.collateralLeft, 1e18, 4));
        row("USDC debt left", fixedPoint(unrescued.debtLeft, USDC_UNIT, 2), fixedPoint(rescued.debtLeft, USDC_UNIT, 2));
        row("USDC spent from reserve", fixedPoint(unrescued.reserveSpent, USDC_UNIT, 2), fixedPoint(rescued.reserveSpent, USDC_UNIT, 2));
        row("net equity USD", fixedPoint(unrescued.netEquityBase, 1e8, 2), fixedPoint(rescued.netEquityBase, 1e8, 2));
        console2.log("liquidator paid USDC", fixedPoint(unrescued.liquidatorPaid, USDC_UNIT, 2));
        console2.log("liquidator received WETH", fixedPoint(unrescued.liquidatorReceived, 1e18, 4));
        console2.log("borrower is better off by USD", fixedPoint(savedBase, 1e8, 2));
    }

    function row(string memory label, string memory left, string memory right) internal pure {
        console2.log(string.concat(label, ": no rescue ", left, " | rescued ", right));
    }
}
