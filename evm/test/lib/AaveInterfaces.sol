// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// Minimal surface of the deployed Aave v3 contracts, declared here so the tests
/// exercise the live bytecode and not a vendored copy of the library.
interface IPool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;

    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)
        external;

    function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf)
        external
        returns (uint256);

    function liquidationCall(
        address collateralAsset,
        address debtAsset,
        address user,
        uint256 debtToCover,
        bool receiveAToken
    ) external;

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

    function getReserveAToken(address asset) external view returns (address);

    function getReserveVariableDebtToken(address asset) external view returns (address);

    function ADDRESSES_PROVIDER() external view returns (address);

    function POOL_REVISION() external view returns (uint256);
}

interface IPoolAddressesProvider {
    function getPriceOracle() external view returns (address);
}

interface IAaveOracle {
    function getAssetPrice(address asset) external view returns (uint256);
}

interface IERC20Like {
    function balanceOf(address account) external view returns (uint256);

    function allowance(address owner, address spender) external view returns (uint256);

    function approve(address spender, uint256 amount) external returns (bool);

    function transfer(address to, uint256 amount) external returns (bool);
}

interface IScaledBalance {
    function scaledBalanceOf(address user) external view returns (uint256);
}

/// Aave's custom errors, spelled here so a test fails if the deployed revert changes.
interface IAaveErrors {
    error InvalidAmount();
    error NoDebtOfSelectedType();
    error NoExplicitAmountToRepayOnBehalf();
    error HealthFactorNotBelowThreshold();
}
