// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

// The parts of Aave v3 that LeveeUnwind calls. Declared here rather than vendored, so
// the contract and its fork tests run against the deployed bytecode.

/// `Pool.getReserveData` return value. Its layout is the same on every Pool revision
/// in docs/SPEC.md section 3, from 3 to 11.
struct AaveReserveData {
    uint256 configuration;
    uint128 liquidityIndex;
    uint128 currentLiquidityRate;
    uint128 variableBorrowIndex;
    uint128 currentVariableBorrowRate;
    uint128 currentStableBorrowRate;
    uint40 lastUpdateTimestamp;
    uint16 id;
    address aTokenAddress;
    address stableDebtTokenAddress;
    address variableDebtTokenAddress;
    address interestRateStrategyAddress;
    uint128 accruedToTreasury;
    uint128 unbacked;
    uint128 isolationModeTotalDebt;
}

interface IAaveAddressesProvider {
    function getPool() external view returns (address);

    function getPriceOracle() external view returns (address);

    /// Zero where the market has no sentinel. L2 markets use one to pause liquidations
    /// while the sequencer is down and for a grace period after it comes back.
    function getPriceOracleSentinel() external view returns (address);
}

interface IPriceOracleSentinel {
    /// False while the sequencer is down or inside the grace period after it restarts.
    function isLiquidationAllowed() external view returns (bool);
}

interface IAavePriceOracle {
    /// Price of one whole unit of `asset` in the base currency, USD with 8 decimals on
    /// the markets Levee uses.
    function getAssetPrice(address asset) external view returns (uint256);
}

interface IAavePool {
    function getReserveData(address asset) external view returns (AaveReserveData memory);

    /// The reserve's income index now, in ray: what one scaled aToken unit is worth.
    function getReserveNormalizedIncome(address asset) external view returns (uint256);

    function getUserAccountData(address user)
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        );

    function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf)
        external
        returns (uint256);

    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}
