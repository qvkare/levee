// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {console2} from "forge-std/console2.sol";
import {AaveFork} from "./AaveFork.sol";
import {IAaveErrors, IPool, IERC20Like} from "./AaveInterfaces.sol";

/// The repay path Levee depends on. Base and Arbitrum inherit it unchanged, so both
/// chains are held to the same assertions.
abstract contract RepayPath is AaveFork {
    uint256 internal constant COLLATERAL = 10 ether;
    uint256 internal constant START_HEALTH_FACTOR = 1.5e18;
    uint256 internal constant REPAY = 2_500e6;

    uint256 internal debt;

    function setUp() public virtual override {
        super.setUp();
        debt = openPosition(borrower, COLLATERAL, START_HEALTH_FACTOR);
    }

    function test_specChainFacts() public view {
        assertEq(IPool.repay.selector, bytes4(0x573ade81), "repay selector");
        assertEq(IERC20Like.approve.selector, bytes4(0x095ea7b3), "approve selector");
        assertEq(IERC20Like.transfer.selector, bytes4(0xa9059cbb), "transfer selector");
        assertGt(address(pool).code.length, 0, "no pool at the spec address");
        assertGt(address(usdc).code.length, 0, "no USDC at the spec address");
        console2.log(target.name, "pool revision", pool.POOL_REVISION());
    }

    function test_position_hasWethCollateralAndUsdcVariableDebt() public view {
        assertApproxEqAbs(aWeth.balanceOf(borrower), COLLATERAL, 1, "aWETH balance");
        assertApproxEqAbs(vDebtUsdc.balanceOf(borrower), debt, DEBT_ROUNDING, "variable debt");

        (uint256 collateralBase, uint256 debtBase,, uint256 threshold,, uint256 healthFactor) =
            pool.getUserAccountData(borrower);
        uint256 wethValue = COLLATERAL * oracle.getAssetPrice(address(weth)) / 1e18;
        assertApproxEqAbs(collateralBase, wethValue, 1, "collateral is priced from the oracle");
        assertGt(debtBase, 0, "debt is priced from the oracle");
        assertGt(threshold, 0, "WETH carries a liquidation threshold");
        assertApproxEqRel(healthFactor, START_HEALTH_FACTOR, 1e12, "position opens at the sized HF");
    }

    function test_thirdPartyRepay_explicitAmount_collateralDoesNotMove() public {
        fundRescuer(rescuer, REPAY, REPAY);

        uint256 scaledBefore = scaledCollateralOf(borrower);
        uint256 aWethBefore = aWeth.balanceOf(borrower);
        uint256 walletWethBefore = weth.balanceOf(borrower);
        uint256 walletUsdcBefore = usdc.balanceOf(borrower);
        uint256 debtBefore = vDebtUsdc.balanceOf(borrower);
        uint256 collateralBefore = collateralBaseOf(borrower);
        uint256 healthBefore = healthFactorOf(borrower);

        vm.prank(rescuer);
        uint256 repaid = pool.repay(address(usdc), REPAY, VARIABLE_RATE, borrower);

        assertEq(repaid, REPAY, "repay returns the explicit amount");
        assertEq(usdc.balanceOf(rescuer), 0, "rescuer paid exactly the amount");
        assertApproxEqAbs(vDebtUsdc.balanceOf(borrower), debtBefore - REPAY, DEBT_ROUNDING, "debt fell");
        assertGt(healthFactorOf(borrower), healthBefore, "health factor rose");

        // The collateral checks are exact. Nothing about a repay should touch them.
        assertEq(scaledCollateralOf(borrower), scaledBefore, "scaled collateral moved");
        assertEq(aWeth.balanceOf(borrower), aWethBefore, "aWETH moved");
        assertEq(weth.balanceOf(borrower), walletWethBefore, "wallet WETH moved");
        assertEq(usdc.balanceOf(borrower), walletUsdcBefore, "wallet USDC moved");
        assertEq(collateralBaseOf(borrower), collateralBefore, "collateral value moved");

        // The rescuer takes on no Aave position of its own.
        assertEq(aWeth.balanceOf(rescuer), 0, "rescuer gained collateral");
        assertEq(vDebtUsdc.balanceOf(rescuer), 0, "rescuer gained debt");
    }

    function test_repayFormula_reachesTarget() public {
        uint256 targetHealthFactor = 1.75e18;
        uint256 amount = repayToTarget(borrower, targetHealthFactor);
        fundRescuer(rescuer, amount, amount);

        vm.prank(rescuer);
        pool.repay(address(usdc), amount, VARIABLE_RATE, borrower);

        uint256 healthFactor = healthFactorOf(borrower);
        console2.log(target.name, "repay to reach 1.75 (USDC units)", amount);
        console2.log(target.name, "health factor after (wad)", healthFactor);
        assertGe(healthFactor, targetHealthFactor, "stopped short of the target");
        // One USDC base unit of overshoot on a debt this size moves HF by far less than 1e-6.
        assertApproxEqRel(healthFactor, targetHealthFactor, 1e12, "overshot the target");
    }

    function test_maxUintOnBehalf_reverts() public {
        fundRescuer(rescuer, debt * 2, type(uint256).max);
        uint256 rescuerBefore = usdc.balanceOf(rescuer);
        uint256 debtBefore = vDebtUsdc.balanceOf(borrower);

        vm.prank(rescuer);
        vm.expectRevert(IAaveErrors.NoExplicitAmountToRepayOnBehalf.selector);
        pool.repay(address(usdc), type(uint256).max, VARIABLE_RATE, borrower);

        assertEq(usdc.balanceOf(rescuer), rescuerBefore, "funds moved on a reverted repay");
        assertEq(vDebtUsdc.balanceOf(borrower), debtBefore, "debt moved on a reverted repay");
    }

    /// The same call is legal for the borrower, which is why the revert is about the
    /// caller and not the amount.
    function test_maxUintBySelf_clearsDebt() public {
        deal(address(usdc), borrower, debt + 1_000e6);
        vm.startPrank(borrower);
        usdc.approve(address(pool), type(uint256).max);
        uint256 repaid = pool.repay(address(usdc), type(uint256).max, VARIABLE_RATE, borrower);
        vm.stopPrank();

        assertApproxEqAbs(repaid, debt, DEBT_ROUNDING, "repaid the whole debt");
        assertEq(vDebtUsdc.balanceOf(borrower), 0, "debt cleared");
    }

    function test_amountAboveDebt_chargesOnlyTheDebt() public {
        uint256 excess = 1_000e6;
        uint256 amount = debt + excess;
        uint256 startingAllowance = amount + 7;
        fundRescuer(rescuer, amount, startingAllowance);
        uint256 owed = vDebtUsdc.balanceOf(borrower);

        vm.prank(rescuer);
        uint256 repaid = pool.repay(address(usdc), amount, VARIABLE_RATE, borrower);

        console2.log(target.name, "amount sent to repay", amount);
        console2.log(target.name, "debt owed", owed);
        console2.log(target.name, "repay returned", repaid);
        console2.log(target.name, "rescuer balance left", usdc.balanceOf(rescuer));

        assertEq(repaid, owed, "repay is clamped to the debt");
        assertEq(usdc.balanceOf(rescuer), amount - owed, "only the debt left the rescuer");
        assertEq(
            usdc.allowance(address(rescuer), address(pool)),
            startingAllowance - owed,
            "only the debt was pulled from the allowance"
        );
        assertEq(vDebtUsdc.balanceOf(borrower), 0, "debt cleared");
        assertEq(debtBaseOf(borrower), 0, "account shows no debt");
        assertEq(healthFactorOf(borrower), type(uint256).max, "health factor is max with no debt");
    }

    function test_repayWithoutAllowance_reverts() public {
        fundRescuer(rescuer, REPAY, REPAY - 1);
        uint256 debtBefore = vDebtUsdc.balanceOf(borrower);

        vm.prank(rescuer);
        vm.expectRevert();
        pool.repay(address(usdc), REPAY, VARIABLE_RATE, borrower);

        assertEq(usdc.balanceOf(rescuer), REPAY, "funds moved on a reverted repay");
        assertEq(vDebtUsdc.balanceOf(borrower), debtBefore, "debt moved on a reverted repay");
    }

    function test_repayZero_reverts() public {
        fundRescuer(rescuer, REPAY, REPAY);
        vm.prank(rescuer);
        vm.expectRevert(IAaveErrors.InvalidAmount.selector);
        pool.repay(address(usdc), 0, VARIABLE_RATE, borrower);
    }

    /// The race a keeper can lose: the debt is gone by the time its repay lands.
    function test_repayAfterDebtCleared_reverts_withoutCharging() public {
        fundRescuer(rescuer, debt * 2, type(uint256).max);
        uint256 amount = debt + 1_000e6;

        vm.prank(rescuer);
        pool.repay(address(usdc), amount, VARIABLE_RATE, borrower);
        uint256 rescuerBefore = usdc.balanceOf(rescuer);

        vm.prank(rescuer);
        vm.expectRevert(IAaveErrors.NoDebtOfSelectedType.selector);
        pool.repay(address(usdc), REPAY, VARIABLE_RATE, borrower);

        assertEq(usdc.balanceOf(rescuer), rescuerBefore, "funds moved on a reverted repay");
    }
}
