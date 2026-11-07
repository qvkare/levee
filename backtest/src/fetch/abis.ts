import { parseAbi } from 'viem';

export const POOL_ABI = parseAbi([
  'function ADDRESSES_PROVIDER() view returns (address)',
  'function getReservesList() view returns (address[])',
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
  'function getUserEMode(address user) view returns (uint256)',
  'function getUserConfiguration(address user) view returns (uint256)',
  'function getEModeCategoryCollateralConfig(uint8 id) view returns (uint16 ltv, uint16 liquidationThreshold, uint16 liquidationBonus)',
  'function getEModeCategoryCollateralBitmap(uint8 id) view returns (uint128)',
  'function getReserveData(address asset) view returns (uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt)',
]);

export const PROVIDER_ABI = parseAbi([
  'function getPriceOracle() view returns (address)',
  'function getPoolDataProvider() view returns (address)',
]);

export const ORACLE_ABI = parseAbi([
  'function getSourceOfAsset(address asset) view returns (address)',
  'function getAssetPrice(address asset) view returns (uint256)',
  'function getAssetsPrices(address[] assets) view returns (uint256[])',
]);

export const DATA_PROVIDER_ABI = parseAbi([
  'function getReserveConfigurationData(address asset) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)',
  'function getLiquidationProtocolFee(address asset) view returns (uint256)',
  'function getReserveTokensAddresses(address asset) view returns (address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress)',
]);

export const ERC20_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address owner) view returns (uint256)',
]);

export const FEED_ABI = parseAbi([
  'function aggregator() view returns (address)',
  'function description() view returns (string)',
  'function BASE_TO_USD_AGGREGATOR() view returns (address)',
  'function ASSET_TO_USD_AGGREGATOR() view returns (address)',
]);
