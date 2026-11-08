// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {AaveReserveData, IAaveAddressesProvider, IAavePool, IAavePriceOracle} from "./interfaces/IAaveV3.sol";
import {IUniswapV3Factory, IUniswapV3Pool, IUniswapV3SwapCallback} from "./interfaces/IUniswapV3.sol";

/// @title LeveeUnwind
/// @notice Repays part of a borrower's Aave v3 USDC variable debt by selling a slice of
/// their own collateral, in one transaction, when their health factor is below a trigger
/// they chose. docs/SPEC.md section 9.
///
/// A borrower opts in by calling `authorize` from their own wallet and by approving this
/// contract to spend a capped amount of their collateral's aToken. Their limits are that
/// allowance, the slippage bound, the trigger and target, and the NEAR contract's caps.
///
/// The flow is a Uniswap v3 exact-output swap. The pool sends the USDC first, then calls
/// back; in the callback this contract repays the debt, pulls the aTokens the pool is owed
/// from the borrower, and withdraws the collateral from Aave straight to the pool. Debt
/// goes down before collateral leaves, so Aave's health factor check on the aToken
/// transfer passes even close to liquidation.
///
/// There is no owner, no upgrade, no delegatecall, no arbitrary call and no ETH handling.
/// Between calls the contract holds no tokens and no allowance.
contract LeveeUnwind is IUniswapV3SwapCallback {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using SafeCast for int256;

    /// What a borrower agreed to. Health factors are 1e18-scaled, as Aave reports them.
    struct Authorization {
        address rescuer;
        uint16 maxSlippageBps;
        uint64 triggerHf;
        uint64 targetHf;
    }

    /// Carried through the Uniswap callback. Only ever decoded in a callback from the pool
    /// this contract itself called, so it is the data `unwind` encoded.
    struct CallbackData {
        address borrower;
        address collateral;
        address aToken;
        address aavePool;
        uint256 amount;
        uint256 maxIn;
        bool collateralIsToken0;
    }

    /// The quantities `unwind` works out before the swap and checks after it.
    struct Plan {
        IAavePool aavePool;
        address uniswapPool;
        address aToken;
        uint256 amount;
        uint256 maxIn;
        uint256 collateralPrice;
        uint256 collateralUnit;
        uint256 usdcPrice;
        uint256 usdcUnit;
        bool collateralIsToken0;
    }

    uint16 public constant MAX_SLIPPAGE_BPS = 300;
    uint64 public constant MIN_TRIGGER_HF = 1e18;
    uint64 public constant MAX_TARGET_HF = 3e18;
    /// Headroom above the computed health factor bound, as a share of the target. It
    /// covers rounding in Aave's account data and an oracle update between the keeper's
    /// read and the transaction landing. See `_healthFactorBound`.
    uint256 public constant HF_MARGIN_BPS = 100;

    uint256 private constant BPS = 10_000;
    uint256 private constant WAD = 1e18;
    uint256 private constant VARIABLE_RATE = 2;
    /// Uniswap v3 TickMath.MIN_SQRT_RATIO + 1 and MAX_SQRT_RATIO - 1. The swap is bounded
    /// by `maxIn` in the callback, not by a price limit.
    uint160 private constant MIN_SQRT_PRICE_LIMIT = 4_295_128_740;
    uint160 private constant MAX_SQRT_PRICE_LIMIT = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341;

    /// Aave ReserveConfiguration bits. Stable since v3.0.
    uint256 private constant DECIMALS_SHIFT = 48;
    uint256 private constant ACTIVE_BIT = 56;
    uint256 private constant FROZEN_BIT = 57;
    uint256 private constant PAUSED_BIT = 60;

    IAaveAddressesProvider public immutable ADDRESSES_PROVIDER;
    address public immutable USDC;
    IUniswapV3Factory public immutable UNISWAP_V3_FACTORY;

    mapping(address borrower => Authorization) private _authorizations;

    /// Set for the whole of `unwind`.
    bool private transient _locked;
    /// The Uniswap pool an `unwind` is swapping on. Non-zero only between the swap call
    /// and the start of its callback, which clears it, so a callback is accepted once.
    address private transient _swapPool;

    event Authorized(
        address indexed borrower, address indexed rescuer, uint16 maxSlippageBps, uint64 triggerHf, uint64 targetHf
    );
    event Revoked(address indexed borrower, address indexed rescuer);
    event Unwound(
        address indexed borrower, address indexed rescuer, address indexed collateral, uint256 repaid, uint256 sold
    );

    error ZeroAddress();
    error NotUsdcReserve();
    error NotUniswapV3Factory();
    error InvalidRescuer();
    error InvalidSlippage(uint16 maxSlippageBps);
    error InvalidHealthFactors(uint64 triggerHf, uint64 targetHf);
    error Reentrancy();
    error NotRescuer();
    error ZeroAmount();
    error CollateralIsUsdc();
    error AboveTrigger(uint256 healthFactor, uint256 triggerHf);
    error NotAnAaveReserve(address asset);
    error CollateralUnavailable(address collateral);
    error NoDebt();
    error NoOraclePrice();
    error PoolNotFound(address collateral, uint24 poolFee);
    error CallbackNotCalled();
    error UnexpectedCallback();
    error PartialFill(uint256 received, uint256 expected);
    error SlippageExceeded(uint256 owed, uint256 maxIn);
    error RepayMismatch(uint256 repaid, uint256 expected);
    error ShortWithdraw(uint256 withdrawn, uint256 owed);
    error NoImprovement(uint256 healthFactorBefore, uint256 healthFactorAfter);
    error OverSold(uint256 healthFactorAfter, uint256 bound);

    /// @param addressesProvider Aave v3 PoolAddressesProvider. The Pool and oracle are read
    /// from it on every call, so a governance change to either is followed.
    /// @param usdc The USDC reserve whose variable debt is repaid.
    /// @param uniswapV3Factory The Uniswap v3 factory that pools are looked up in.
    constructor(address addressesProvider, address usdc, address uniswapV3Factory) {
        if (addressesProvider == address(0) || usdc == address(0) || uniswapV3Factory == address(0)) {
            revert ZeroAddress();
        }
        ADDRESSES_PROVIDER = IAaveAddressesProvider(addressesProvider);
        USDC = usdc;
        UNISWAP_V3_FACTORY = IUniswapV3Factory(uniswapV3Factory);

        // An immutable contract with a wrong argument should fail here, not at the first rescue.
        IAavePool aavePool = IAavePool(ADDRESSES_PROVIDER.getPool());
        if (aavePool.getReserveData(usdc).variableDebtTokenAddress == address(0)) revert NotUsdcReserve();
        if (UNISWAP_V3_FACTORY.feeAmountTickSpacing(500) != 10) revert NotUniswapV3Factory();
    }

    /// @notice Lets `rescuer` unwind the caller's position, replacing any earlier
    /// authorization.
    /// @param maxSlippageBps How much worse than Aave's oracle the swap may be, all costs
    /// included. 1 to 300.
    /// @param triggerHf `unwind` only works while the health factor is below this.
    /// @param targetHf The health factor an unwind aims for. It may land a little above,
    /// within `_healthFactorBound`, never far past it.
    function authorize(address rescuer, uint16 maxSlippageBps, uint64 triggerHf, uint64 targetHf) external {
        if (rescuer == address(0)) revert InvalidRescuer();
        if (maxSlippageBps == 0 || maxSlippageBps > MAX_SLIPPAGE_BPS) revert InvalidSlippage(maxSlippageBps);
        if (triggerHf <= MIN_TRIGGER_HF || triggerHf >= targetHf || targetHf > MAX_TARGET_HF) {
            revert InvalidHealthFactors(triggerHf, targetHf);
        }
        _authorizations[msg.sender] =
            Authorization({rescuer: rescuer, maxSlippageBps: maxSlippageBps, triggerHf: triggerHf, targetHf: targetHf});
        emit Authorized(msg.sender, rescuer, maxSlippageBps, triggerHf, targetHf);
    }

    /// @notice Removes the caller's authorization. Never reverts, so it always works as a
    /// stop. Setting the aToken allowance to zero stops unwinds as well.
    function revoke() external {
        address rescuer = _authorizations[msg.sender].rescuer;
        delete _authorizations[msg.sender];
        emit Revoked(msg.sender, rescuer);
    }

    /// @notice A borrower's whole configuration. All zero if they have not authorized.
    function authorizationOf(address borrower)
        external
        view
        returns (address rescuer, uint16 maxSlippageBps, uint64 triggerHf, uint64 targetHf)
    {
        Authorization memory auth = _authorizations[borrower];
        return (auth.rescuer, auth.maxSlippageBps, auth.triggerHf, auth.targetHf);
    }

    /// @notice Sells `borrower`'s `collateral` on the Uniswap v3 pool for (`collateral`,
    /// USDC, `poolFee`) to repay `amount` of their USDC variable debt.
    /// @dev Reverts unless the caller is the borrower's rescuer, the health factor is below
    /// the trigger, the pool exists, the collateral owed is within the oracle bound, and the
    /// health factor ends higher than it started and not far past the target.
    /// @param amount USDC base units. Capped at the current debt.
    /// @return repaid USDC repaid, in base units.
    /// @return sold Collateral the borrower gave up, in its base units.
    function unwind(address borrower, address collateral, uint256 amount, uint24 poolFee)
        external
        returns (uint256 repaid, uint256 sold)
    {
        if (_locked) revert Reentrancy();
        _locked = true;

        Authorization memory auth = _authorizations[borrower];
        if (auth.rescuer == address(0) || msg.sender != auth.rescuer) revert NotRescuer();
        if (amount == 0) revert ZeroAmount();
        if (collateral == USDC) revert CollateralIsUsdc();

        IAavePool aavePool = IAavePool(ADDRESSES_PROVIDER.getPool());
        (,,,,, uint256 hfBefore) = aavePool.getUserAccountData(borrower);
        if (hfBefore >= auth.triggerHf) revert AboveTrigger(hfBefore, auth.triggerHf);

        Plan memory plan = _plan(aavePool, borrower, collateral, amount, poolFee, auth.maxSlippageBps);
        (repaid, sold) = _swap(plan, borrower, collateral);
        _checkOutcome(plan, borrower, auth, poolFee, hfBefore, repaid, sold);

        emit Unwound(borrower, msg.sender, collateral, repaid, sold);
        _locked = false;
    }

    /// @inheritdoc IUniswapV3SwapCallback
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        address expected = _swapPool;
        if (expected == address(0) || msg.sender != expected) revert UnexpectedCallback();
        _swapPool = address(0);

        CallbackData memory d = abi.decode(data, (CallbackData));
        (int256 collateralDelta, int256 usdcDelta) =
            d.collateralIsToken0 ? (amount0Delta, amount1Delta) : (amount1Delta, amount0Delta);

        // Exact output: the pool has sent the USDC and asks for collateral. It sends less
        // only if it ran out of liquidity, and then this would repay less than planned.
        if (usdcDelta != -d.amount.toInt256()) {
            revert PartialFill(usdcDelta < 0 ? (-usdcDelta).toUint256() : 0, d.amount);
        }
        if (collateralDelta <= 0) revert UnexpectedCallback();
        uint256 owed = collateralDelta.toUint256();
        if (owed > d.maxIn) revert SlippageExceeded(owed, d.maxIn);

        // Repay first, so the aToken transfer below passes Aave's health factor check.
        IERC20(USDC).forceApprove(d.aavePool, d.amount);
        uint256 repaid = IAavePool(d.aavePool).repay(USDC, d.amount, VARIABLE_RATE, d.borrower);
        if (repaid != d.amount) revert RepayMismatch(repaid, d.amount);

        // Withdrawing the whole balance burns every scaled unit, so no aToken dust stays here.
        // Aave rounds the transfer in the receiver's favour, so the balance covers `owed`.
        IERC20(d.aToken).safeTransferFrom(d.borrower, address(this), owed);
        uint256 withdrawn = IAavePool(d.aavePool).withdraw(d.collateral, type(uint256).max, msg.sender);
        if (withdrawn < owed) revert ShortWithdraw(withdrawn, owed);
    }

    function _plan(
        IAavePool aavePool,
        address borrower,
        address collateral,
        uint256 amount,
        uint24 poolFee,
        uint16 maxSlippageBps
    ) private view returns (Plan memory plan) {
        plan.aavePool = aavePool;

        AaveReserveData memory c = aavePool.getReserveData(collateral);
        if (c.aTokenAddress == address(0)) revert NotAnAaveReserve(collateral);
        // Aave itself lets a frozen reserve be withdrawn. Frozen and paused collateral is
        // refused here because docs/SPEC.md section 9 lists both as failure conditions.
        uint256 config = c.configuration;
        if ((config >> ACTIVE_BIT) & 1 == 0 || (config >> FROZEN_BIT) & 1 == 1 || (config >> PAUSED_BIT) & 1 == 1) {
            revert CollateralUnavailable(collateral);
        }
        plan.aToken = c.aTokenAddress;
        plan.collateralUnit = 10 ** ((config >> DECIMALS_SHIFT) & 0xff);

        AaveReserveData memory u = aavePool.getReserveData(USDC);
        uint256 debt = IERC20(u.variableDebtTokenAddress).balanceOf(borrower);
        if (debt == 0) revert NoDebt();
        plan.amount = Math.min(amount, debt);
        plan.usdcUnit = 10 ** ((u.configuration >> DECIMALS_SHIFT) & 0xff);

        IAavePriceOracle oracle = IAavePriceOracle(ADDRESSES_PROVIDER.getPriceOracle());
        plan.collateralPrice = oracle.getAssetPrice(collateral);
        plan.usdcPrice = oracle.getAssetPrice(USDC);
        if (plan.collateralPrice == 0 || plan.usdcPrice == 0) revert NoOraclePrice();

        // maxIn = amount * price(USDC) / price(collateral) * (1 + slippage), in collateral
        // base units. Both prices are in the oracle's base currency, so its unit cancels.
        // One rounding, down, which is the borrower's side.
        plan.maxIn = Math.mulDiv(
            plan.amount,
            plan.usdcPrice * plan.collateralUnit * (BPS + maxSlippageBps),
            plan.collateralPrice * plan.usdcUnit * BPS
        );

        plan.uniswapPool = UNISWAP_V3_FACTORY.getPool(collateral, USDC, poolFee);
        if (plan.uniswapPool == address(0)) revert PoolNotFound(collateral, poolFee);
        plan.collateralIsToken0 = collateral < USDC;
    }

    function _swap(Plan memory plan, address borrower, address collateral)
        private
        returns (uint256 repaid, uint256 sold)
    {
        bytes memory data = abi.encode(
            CallbackData({
                borrower: borrower,
                collateral: collateral,
                aToken: plan.aToken,
                aavePool: address(plan.aavePool),
                amount: plan.amount,
                maxIn: plan.maxIn,
                collateralIsToken0: plan.collateralIsToken0
            })
        );

        _swapPool = plan.uniswapPool;
        (int256 amount0, int256 amount1) = IUniswapV3Pool(plan.uniswapPool)
            .swap(
                address(this),
                plan.collateralIsToken0,
                -plan.amount.toInt256(),
                plan.collateralIsToken0 ? MIN_SQRT_PRICE_LIMIT : MAX_SQRT_PRICE_LIMIT,
                data
            );
        if (_swapPool != address(0)) revert CallbackNotCalled();

        repaid = plan.amount;
        sold = (plan.collateralIsToken0 ? amount0 : amount1).toUint256();
    }

    function _checkOutcome(
        Plan memory plan,
        address borrower,
        Authorization memory auth,
        uint24 poolFee,
        uint256 hfBefore,
        uint256 repaid,
        uint256 sold
    ) private view {
        (, uint256 debtAfterBase,,,, uint256 hfAfter) = plan.aavePool.getUserAccountData(borrower);
        if (hfAfter <= hfBefore) revert NoImprovement(hfBefore, hfAfter);

        uint256 bound = _healthFactorBound(plan, auth, poolFee, debtAfterBase, repaid, sold);
        if (hfAfter > bound) revert OverSold(hfAfter, bound);
    }

    /// @dev The highest health factor an honest keeper can land on.
    ///
    /// The keeper sizes the repay R for the worst cost it allows, s_w = maxSlippageBps plus
    /// the pool fee, with docs/SPEC.md's R = (T*D - C*L) / (T - L_c*(1 + s_w)). If the swap
    /// actually costs s, the health factor lands at
    ///
    ///     HF = T + R * L_c * (s_w - s) / D_after
    ///
    /// where L_c < 1 is the collateral's liquidation threshold and D_after the debt left,
    /// both in Aave's base currency. R * (s_w - s) is what a worst-case swap would have
    /// spent less what this one did, so with L_c taken as 1 the bound needs no reserve
    /// parameters and uses Aave's own account data, which already handles eMode and
    /// several collaterals. HF_MARGIN_BPS of the target is added on top.
    ///
    /// Repaying everything leaves no debt and an unbounded health factor, so it never
    /// passes: no target up to MAX_TARGET_HF needs it.
    function _healthFactorBound(
        Plan memory plan,
        Authorization memory auth,
        uint24 poolFee,
        uint256 debtAfterBase,
        uint256 repaid,
        uint256 sold
    ) private pure returns (uint256 bound) {
        bound = uint256(auth.targetHf) + uint256(auth.targetHf) * HF_MARGIN_BPS / BPS;
        if (debtAfterBase == 0) return bound;

        // Uniswap fees are in hundredths of a basis point.
        uint256 worstCostBps = uint256(auth.maxSlippageBps) + Math.ceilDiv(poolFee, 100);
        uint256 repaidBase = Math.mulDiv(repaid, plan.usdcPrice, plan.usdcUnit);
        uint256 worstSpendBase = Math.mulDiv(repaidBase, BPS + worstCostBps, BPS);
        uint256 soldBase = Math.mulDiv(sold, plan.collateralPrice, plan.collateralUnit);
        if (worstSpendBase > soldBase) {
            bound += Math.mulDiv(worstSpendBase - soldBase, WAD, debtAfterBase);
        }
    }
}
