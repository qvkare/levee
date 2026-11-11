// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {console2} from "forge-std/console2.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Vm} from "forge-std/Vm.sol";
import {LeveeUnwind} from "../../src/LeveeUnwind.sol";
import {AaveReserveData, IAaveAddressesProvider, IAavePool} from "../../src/interfaces/IAaveV3.sol";
import {IUniswapV3Factory, IUniswapV3Pool} from "../../src/interfaces/IUniswapV3.sol";
import {Deployments, UnwindArgs} from "../../script/lib/Deployments.sol";
import {AaveFork} from "./AaveFork.sol";
import {IERC20Like, IScaledBalance} from "./AaveInterfaces.sol";

/// Uniswap v3-periphery QuoterV2, the call the keeper makes to set `maxSold`.
interface IQuoterV2 {
    struct QuoteExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amount;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function factory() external view returns (address);

    // forge-lint: disable-next-line(mixed-case-function)
    function WETH9() external view returns (address);

    function quoteExactOutputSingle(QuoteExactOutputSingleParams memory params)
        external
        returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate);
}

/// eMode reads, Aave v3.2 and later.
interface IPoolEMode {
    struct CollateralConfig {
        uint16 ltv;
        uint16 liquidationThreshold;
        uint16 liquidationBonus;
    }

    function getUserEMode(address user) external view returns (uint256);

    function getEModeCategoryCollateralConfig(uint8 id) external view returns (CollateralConfig memory);

    function setUserEMode(uint8 categoryId) external;
}

/// What the unwind suites need beyond AaveFork's ForkTarget.
struct UnwindTarget {
    address uniswapV3Factory;
    /// The WETH/USDC pool with the most in-range liquidity at the pinned block.
    uint24 deepFee;
    address deepPool;
    /// A second real WETH/USDC tier the happy path also runs on. Zero if there is none.
    uint24 otherFee;
    address otherPool;
    /// A collateral with a non-zero LTV, for the position whose WETH is too small.
    address secondCollateral;
}

library UnwindTargets {
    /// In-range liquidity at block 54,260,000: 3.25e19 at 0.30%, 7.81e17 at 0.05%. The
    /// 0.30% pool is deepest and also holds the most of both tokens.
    function base() internal pure returns (UnwindTarget memory) {
        return UnwindTarget({
            uniswapV3Factory: Deployments.BASE_UNISWAP_V3_FACTORY,
            deepFee: 3000,
            deepPool: 0x6c561B446416E1A00E8E93E221854d6eA4171372,
            otherFee: 500,
            otherPool: 0xd0b53D9277642d899DF5C87A3966A349A798F224,
            secondCollateral: 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf // cbBTC
        });
    }

    /// In-range liquidity at the pinned block: 3.69e18 at 0.05%, 5.96e17 at 0.30%.
    function arbitrum() internal pure returns (UnwindTarget memory) {
        return UnwindTarget({
            uniswapV3Factory: Deployments.ARBITRUM_UNISWAP_V3_FACTORY,
            deepFee: 500,
            deepPool: 0xC6962004f452bE9203591991D15f6b388e09E8D0,
            otherFee: 3000,
            otherPool: 0xc473e2aEE3441BF9240Be85eb122aBB059A3B57c,
            secondCollateral: 0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f // WBTC
        });
    }

    /// The 0.30% pool is the one the seed script moves to the oracle price and fills, as
    /// it will on the live testnet. At the pinned block it sat at 0.60 of the oracle price.
    function baseSepolia() internal pure returns (UnwindTarget memory) {
        return UnwindTarget({
            uniswapV3Factory: Deployments.BASE_SEPOLIA_UNISWAP_V3_FACTORY,
            deepFee: 3000,
            deepPool: 0x92266210FacF124f190fbad79AA230dfB85926Ce,
            otherFee: 0,
            otherPool: address(0),
            secondCollateral: 0xD171b9694f7A2597Ed006D41f7509aaD4B485c4B // Aave test cbETH
        });
    }

    /// The 0.30% pool is the one the seed script moves to the oracle price and fills, as
    /// on Base Sepolia. At the pinned block it was empty and priced near zero. The market
    /// lists only WETH and USDC, so there is no second collateral.
    function arbitrumSepolia() internal pure returns (UnwindTarget memory) {
        return UnwindTarget({
            uniswapV3Factory: Deployments.ARBITRUM_SEPOLIA_UNISWAP_V3_FACTORY,
            deepFee: 3000,
            deepPool: 0x99A927D8127b7215FC11Ce1F1009e77ff8B1d1b0,
            otherFee: 0,
            otherPool: address(0),
            secondCollateral: address(0)
        });
    }
}

/// Deploys LeveeUnwind on the fork and gives the suites independent reads to check it by.
abstract contract UnwindFork is AaveFork {
    uint16 internal constant SLIPPAGE_BPS = 100;
    uint64 internal constant TRIGGER_HF = 1.2e18;
    uint64 internal constant TARGET_HF = 1.5e18;
    uint256 internal constant COLLATERAL = 10 ether;
    uint256 internal constant START_HF = 1.05e18;
    /// The keeper's default headroom over a fresh QuoterV2 quote when it sets `maxSold`.
    uint256 internal constant QUOTE_TOLERANCE_BPS = 50;

    /// Aave can round an aToken transfer by a base unit either way.
    uint256 internal constant ATOKEN_ROUNDING = 2;

    /// What an unwind may take from the borrower and pay the pool beyond `sold`. On Aave
    /// v3.0 (Pool revision 3) the helper tops up a shortfall by at least one scaled unit,
    /// worth the income index in base units: about 5 wei of WETH on Arbitrum Sepolia, whose
    /// index is near 4.67. Elsewhere it is ATOKEN_ROUNDING.
    function aTokenRounding() internal view returns (uint256) {
        if (pool.POOL_REVISION() > 3) return ATOKEN_ROUNDING;
        uint256 index = IAavePool(address(pool)).getReserveNormalizedIncome(address(weth));
        return ATOKEN_ROUNDING + 2 * ((index + 1e27 - 1) / 1e27);
    }

    UnwindTarget internal ut;
    LeveeUnwind internal helper;
    IUniswapV3Factory internal uniFactory;
    IUniswapV3Pool internal uniPool;
    IQuoterV2 internal quoter;

    /// Before and after reads for one unwind, none of them from the helper.
    struct Reads {
        uint256 debt;
        uint256 aWeth;
        uint256 aWethAllowance;
        uint256 walletWeth;
        uint256 walletUsdc;
        uint256 poolWeth;
        uint256 poolUsdc;
        uint256 collateralBase;
        uint256 debtBase;
        uint256 healthFactor;
    }

    struct Outcome {
        address user;
        uint256 amount;
        /// The keeper's QuoterV2 quote for `amount`, and the cap it set from it.
        uint256 quote;
        uint256 maxSold;
        uint256 repaid;
        uint256 sold;
        uint256 gasUsed;
        Reads before;
        Reads afterwards;
    }

    function unwindTarget() internal pure virtual returns (UnwindTarget memory);

    /// Base Sepolia seeds its pool here. The mainnets use what is on chain.
    function preparePool() internal virtual {}

    function setUp() public virtual override {
        super.setUp();
        ut = unwindTarget();
        uniFactory = IUniswapV3Factory(ut.uniswapV3Factory);

        UnwindArgs memory args = Deployments.unwindArgs(block.chainid);
        helper = new LeveeUnwind(args.addressesProvider, args.usdc, args.uniswapV3Factory);
        quoter = IQuoterV2(Deployments.quoterV2(block.chainid));

        preparePool();
        uniPool = IUniswapV3Pool(uniFactory.getPool(address(weth), address(usdc), ut.deepFee));
    }

    // ---- positions -------------------------------------------------------------------

    /// Opens a WETH/USDC position at `healthFactor` and authorizes the rescuer with the
    /// default limits. The aToken allowance is capped at the collateral, as the site asks.
    function openRescuable(address user, uint256 healthFactor) internal returns (uint256 debt) {
        debt = openPosition(user, COLLATERAL, healthFactor);
        authorizeAndApprove(user, SLIPPAGE_BPS, TRIGGER_HF, TARGET_HF, COLLATERAL);
    }

    /// Authorizes WETH on the deepest pool, as the site would by default.
    function authorizeAndApprove(address user, uint16 slippage, uint64 trigger, uint64 target, uint256 allowance)
        internal
    {
        authorizeAndApprove(user, slippage, trigger, target, allowance, ut.deepFee);
    }

    function authorizeAndApprove(
        address user,
        uint16 slippage,
        uint64 trigger,
        uint64 target,
        uint256 allowance,
        uint24 fee
    ) internal {
        vm.startPrank(user);
        helper.authorize(rescuer, slippage, trigger, target, address(weth), fee);
        aWeth.approve(address(helper), allowance);
        vm.stopPrank();
    }

    // ---- the keeper's arithmetic, docs/SPEC.md section 9 ------------------------------

    function worstCostBps(uint16 slippage, uint24 fee) internal pure returns (uint256) {
        return uint256(slippage) + (uint256(fee) + 99) / 100;
    }

    /// R = (T*D - C*L) / (T - L_c*(1 + s)) with s the pool fee plus the slippage bound,
    /// converted to USDC at the oracle, rounded up, plus 2 base units. L_c is the one Aave
    /// applies to this user's WETH, so a borrower in eMode is sized with the eMode one.
    function keeperRepay(address user, uint256 targetHf, uint16 slippage, uint24 fee) internal view returns (uint256) {
        (uint256 collateralBase, uint256 debtBase,, uint256 threshold,,) = pool.getUserAccountData(user);
        uint256 lc = wethThresholdBpsFor(user);
        uint256 numerator = targetHf * debtBase - collateralBase * threshold * 1e14;
        uint256 denominator = targetHf - lc * 1e14 * (BPS + worstCostBps(slippage, fee)) / BPS;
        uint256 repayBase = (numerator + denominator - 1) / denominator;
        uint256 price = oracle.getAssetPrice(address(usdc));
        return (repayBase * USDC_UNIT + price - 1) / price + DEBT_ROUNDING;
    }

    /// Collateral the helper may take for `amount` USDC, from the oracle, rounded down.
    function maxCollateralIn(uint256 amount, uint16 slippage) internal view returns (uint256) {
        uint256 usdcValue = amount * oracle.getAssetPrice(address(usdc)) * (BPS + slippage);
        return usdcValue * 1e18 / (USDC_UNIT * oracle.getAssetPrice(address(weth)) * BPS);
    }

    /// The contract's post-check bound, recomputed here from Aave's account data: the
    /// target, plus HF_MARGIN_BPS of the distance from the health factor before to the
    /// target, plus one basis point of the collateral before the sale over the debt left,
    /// plus what a worst-case sale would have spent beyond this one over the debt left.
    function healthFactorBound(
        uint256 repaid,
        uint256 sold,
        uint256 healthFactorBefore,
        uint256 collateralAfterBase,
        uint256 debtAfterBase,
        uint64 targetHf,
        uint16 slippage,
        uint24 fee
    ) internal view returns (uint256 bound) {
        bound = uint256(targetHf) + (uint256(targetHf) - healthFactorBefore) * helper.HF_MARGIN_BPS() / BPS;
        if (debtAfterBase == 0) return bound;
        uint256 repaidBase = repaid * oracle.getAssetPrice(address(usdc)) / USDC_UNIT;
        uint256 soldBase = sold * oracle.getAssetPrice(address(weth)) / 1e18;
        bound += ((collateralAfterBase + soldBase) * WAD + debtAfterBase * BPS - 1) / (debtAfterBase * BPS);
        uint256 worstBase = repaidBase * (BPS + worstCostBps(slippage, fee)) / BPS;
        if (worstBase > soldBase) bound += (worstBase - soldBase) * WAD / debtAfterBase;
    }

    function liquidationThresholdBps(address asset) internal view returns (uint256) {
        return (IAavePool(address(pool)).getReserveData(asset).configuration >> 16) & 0xffff;
    }

    /// WETH's liquidation threshold as Aave applies it to `user`: the eMode one if they
    /// are in a category, which on these forks only a test puts them in.
    function wethThresholdBpsFor(address user) internal view returns (uint256) {
        uint256 category = IPoolEMode(address(pool)).getUserEMode(user);
        if (category == 0) return liquidationThresholdBps(address(weth));
        // forge-lint: disable-next-line(unsafe-typecast)
        return IPoolEMode(address(pool)).getEModeCategoryCollateralConfig(uint8(category)).liquidationThreshold;
    }

    // ---- the keeper's max_sold ---------------------------------------------------------

    /// What QuoterV2 says the pool would take for exactly `amount` USDC, as the keeper
    /// reads it just before asking NEAR to sign.
    function quoteSale(uint256 amount, uint24 fee) internal returns (uint256 amountIn) {
        (amountIn,,,) = quoter.quoteExactOutputSingle(
            IQuoterV2.QuoteExactOutputSingleParams({
                tokenIn: address(weth), tokenOut: address(usdc), amount: amount, fee: fee, sqrtPriceLimitX96: 0
            })
        );
    }

    /// The keeper's `maxSold`: a fresh quote plus QUOTE_TOLERANCE_BPS, rounded down.
    function keeperMaxSold(uint256 amount, uint24 fee) internal returns (uint256) {
        return quoteSale(amount, fee) * (BPS + QUOTE_TOLERANCE_BPS) / BPS;
    }

    // ---- running and reading ----------------------------------------------------------

    function unwindAs(address caller, address user, uint256 amount, uint24 fee, uint256 maxSold)
        internal
        returns (uint256 repaid, uint256 sold, uint256 gasUsed)
    {
        vm.prank(caller);
        uint256 gasBefore = gasleft();
        (repaid, sold) = helper.unwind(user, address(weth), amount, fee, maxSold);
        gasUsed = gasBefore - gasleft();
    }

    function read(address user, IUniswapV3Pool uni) internal view returns (Reads memory r) {
        r.debt = vDebtUsdc.balanceOf(user);
        r.aWeth = aWeth.balanceOf(user);
        r.aWethAllowance = aWeth.allowance(user, address(helper));
        r.walletWeth = weth.balanceOf(user);
        r.walletUsdc = usdc.balanceOf(user);
        r.poolWeth = weth.balanceOf(address(uni));
        r.poolUsdc = usdc.balanceOf(address(uni));
        (r.collateralBase, r.debtBase,,,, r.healthFactor) = pool.getUserAccountData(user);
    }

    /// Runs one unwind of `amount` on the `fee` pool with the default authorization and
    /// checks it against reads made without the helper.
    function unwindAndCheck(address user, uint256 amount, uint24 fee) internal returns (Outcome memory o) {
        return unwindAndCheck(user, amount, fee, SLIPPAGE_BPS, TARGET_HF);
    }

    function unwindAndCheck(address user, uint256 amount, uint24 fee, uint16 slippage, uint64 targetHf)
        internal
        returns (Outcome memory o)
    {
        IUniswapV3Pool uni = IUniswapV3Pool(uniFactory.getPool(address(weth), address(usdc), fee));
        o.user = user;
        o.amount = amount;
        o.quote = quoteSale(amount, fee);
        o.maxSold = o.quote * (BPS + QUOTE_TOLERANCE_BPS) / BPS;
        o.before = read(user, uni);
        uint256 rescuerUsdc = usdc.balanceOf(rescuer);
        uint256 rescuerWeth = weth.balanceOf(rescuer);

        vm.recordLogs();
        (o.repaid, o.sold, o.gasUsed) = unwindAs(rescuer, user, amount, fee, o.maxSold);
        assertUnwoundEvent(vm.getRecordedLogs(), user, o.repaid, o.sold);
        o.afterwards = read(user, uni);
        // Nothing moved the pool between the quote and the swap, so they agree exactly.
        assertEq(o.sold, o.quote, "QuoterV2 predicted the sale");
        assertLe(o.sold, o.maxSold, "sold more than maxSold");

        assertEq(usdc.balanceOf(rescuer), rescuerUsdc, "rescuer USDC moved");
        assertEq(weth.balanceOf(rescuer), rescuerWeth, "rescuer WETH moved");
        assertEq(aWeth.balanceOf(rescuer), 0, "rescuer gained collateral");
        checkBalances(o, slippage);
        checkHealthFactor(o, targetHf, slippage, fee);
        assertHelperClean();
    }

    function checkBalances(Outcome memory o, uint16 slippage) internal view {
        assertEq(o.repaid, o.amount, "repaid is the amount asked for");
        assertApproxEqAbs(o.before.debt - o.afterwards.debt, o.repaid, DEBT_ROUNDING, "debt fell by the repay");
        assertApproxEqAbs(o.before.aWeth - o.afterwards.aWeth, o.sold, aTokenRounding(), "aWETH fell by the sale");
        uint256 allowanceSpent = o.before.aWethAllowance - o.afterwards.aWethAllowance;
        assertGe(allowanceSpent, o.sold, "allowance spent at least the sale");
        assertLe(allowanceSpent, o.sold + aTokenRounding(), "allowance overspent");
        assertEq(o.before.poolUsdc - o.afterwards.poolUsdc, o.repaid, "pool paid out exactly the repay");
        assertGe(o.afterwards.poolWeth - o.before.poolWeth, o.sold, "pool was paid at least what it asked");
        assertLe(o.afterwards.poolWeth - o.before.poolWeth, o.sold + aTokenRounding(), "pool was overpaid");
        assertLe(o.sold, maxCollateralIn(o.amount, slippage), "sold more than the oracle bound");
        assertEq(o.afterwards.walletWeth, o.before.walletWeth, "borrower wallet WETH moved");
        assertEq(o.afterwards.walletUsdc, o.before.walletUsdc, "borrower wallet USDC moved");
    }

    function checkHealthFactor(Outcome memory o, uint64 targetHf, uint16 slippage, uint24 fee) internal view {
        // Aave values collateral at its oracle price, so the account data follows the balance.
        uint256 wethPrice = oracle.getAssetPrice(address(weth));
        assertApproxEqAbs(o.afterwards.collateralBase, o.afterwards.aWeth * wethPrice / 1e18, 1, "collateral value");
        assertGt(o.afterwards.healthFactor, o.before.healthFactor, "health factor rose");

        // Model: the repay leaves at the USDC oracle price, the collateral at its oracle
        // price times its liquidation threshold.
        uint256 soldBase = o.sold * wethPrice / 1e18;
        uint256 repaidBase = o.repaid * oracle.getAssetPrice(address(usdc)) / USDC_UNIT;
        uint256 modelled = (o.before.collateralBase - soldBase) * wethThresholdBpsFor(o.user) * 1e14
            / (o.before.debtBase - repaidBase);
        assertApproxEqRel(o.afterwards.healthFactor, modelled, 1e10, "health factor matches repay-then-sell");
        assertLe(
            o.afterwards.healthFactor,
            healthFactorBound(
                o.repaid,
                o.sold,
                o.before.healthFactor,
                o.afterwards.collateralBase,
                o.afterwards.debtBase,
                targetHf,
                slippage,
                fee
            ),
            "landed past the bound"
        );
    }

    function assertUnwoundEvent(Vm.Log[] memory logs, address user, uint256 repaid, uint256 sold) internal view {
        bytes32 topic = LeveeUnwind.Unwound.selector;
        uint256 found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(helper) || logs[i].topics[0] != topic) continue;
            found++;
            assertEq(logs[i].topics[1], bytes32(uint256(uint160(user))), "event borrower");
            assertEq(logs[i].topics[2], bytes32(uint256(uint160(rescuer))), "event rescuer");
            assertEq(logs[i].topics[3], bytes32(uint256(uint160(address(weth)))), "event collateral");
            (uint256 eventRepaid, uint256 eventSold) = abi.decode(logs[i].data, (uint256, uint256));
            assertEq(eventRepaid, repaid, "event repaid");
            assertEq(eventSold, sold, "event sold");
        }
        assertEq(found, 1, "one Unwound event");
    }

    /// The helper holds nothing between calls: no tokens, no aTokens, no debt, no
    /// allowance and no ETH.
    function assertHelperClean() internal view {
        address h = address(helper);
        assertEq(usdc.balanceOf(h), 0, "helper holds USDC");
        assertEq(weth.balanceOf(h), 0, "helper holds WETH");
        assertEq(aWeth.balanceOf(h), 0, "helper holds aWETH");
        assertEq(IScaledBalance(address(aWeth)).scaledBalanceOf(h), 0, "helper holds scaled aWETH");
        assertEq(vDebtUsdc.balanceOf(h), 0, "helper holds USDC debt");
        assertEq(usdc.allowance(h, address(pool)), 0, "helper left a USDC allowance");
        assertEq(h.balance, 0, "helper holds ETH");
        if (ut.secondCollateral != address(0)) {
            assertEq(IERC20Like(ut.secondCollateral).balanceOf(h), 0, "helper holds the second collateral");
        }
    }

    function logOutcome(string memory label, Outcome memory o) internal view {
        uint256 soldBase = o.sold * oracle.getAssetPrice(address(weth)) / 1e18;
        uint256 repaidBase = o.repaid * oracle.getAssetPrice(address(usdc)) / USDC_UNIT;
        int256 repaidSigned = SafeCast.toInt256(repaidBase);
        int256 costBps = (SafeCast.toInt256(soldBase) - repaidSigned) * 1e6 / repaidSigned;
        console2.log(string.concat(target.name, " ", label));
        console2.log("  unwind gas", o.gasUsed);
        console2.log("  repaid USDC", fixedPoint(o.repaid, USDC_UNIT, 2));
        console2.log("  sold WETH", fixedPoint(o.sold, 1e18, 6));
        console2.log("  cost against oracle, hundredths of a bp", costBps);
        console2.log("  health factor before", fixedPoint(o.before.healthFactor, WAD, 4));
        console2.log("  health factor after", fixedPoint(o.afterwards.healthFactor, WAD, 4));
    }

    function aaveReserve(address asset) internal view returns (AaveReserveData memory) {
        return IAavePool(address(pool)).getReserveData(asset);
    }

    function addressesProvider() internal view returns (IAaveAddressesProvider) {
        return IAaveAddressesProvider(pool.ADDRESSES_PROVIDER());
    }
}
