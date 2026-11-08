/** Reads and writes against one EVM RPC endpoint. No decisions are made here. */
import {
  type Address,
  BaseError,
  type Hex,
  type PublicClient,
  createPublicClient,
  getAddress,
  http,
  parseAbi,
} from 'viem';
import type { FeeQuote } from './fees.js';
import { type AccountLtv, type EModeTerms, collateralIndexes, ltvOf, ltvZeroBlocker } from './ltv.js';
import type { CollateralSample, Sample } from './quorum.js';
import {
  type EvmLog,
  HELPER_CONFIG_VIEW,
  type HelperConfig,
  QUOTER_V2_ABI,
  helperConfigFrom,
} from './unwind.js';

/** Deterministic deployment, present on all four chains in spec section 3. */
const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';

const POOL_ABI = parseAbi([
  'function ADDRESSES_PROVIDER() view returns (address)',
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
  // The newer getReserveVariableDebtToken is missing on Arbitrum Sepolia (revision 3).
  'function getReserveData(address asset) view returns (((uint256 data) configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt) reserve)',
  'function getReservesList() view returns (address[])',
  'function getConfiguration(address asset) view returns ((uint256 data))',
  'function getUserConfiguration(address user) view returns ((uint256 data))',
  'function getUserEMode(address user) view returns (uint256)',
]);

/** Aave v3.2 and later. The last two are v3.7 only, so a failure reads as zero. */
const EMODE_ABI = parseAbi([
  'function getEModeCategoryCollateralBitmap(uint8 id) view returns (uint128)',
  'function getEModeCategoryCollateralConfig(uint8 id) view returns ((uint16 ltv, uint16 liquidationThreshold, uint16 liquidationBonus))',
  'function getEModeCategoryLtvzeroBitmap(uint8 id) view returns (uint128)',
  'function getIsEModeCategoryIsolated(uint8 id) view returns (bool)',
]);

const PROVIDER_ABI = parseAbi(['function getPriceOracle() view returns (address)']);
const ORACLE_ABI = parseAbi([
  'function getAssetPrice(address asset) view returns (uint256)',
  'function getAssetsPrices(address[] assets) view returns (uint256[])',
]);
const ERC20_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

export interface PositionQuery {
  pool: Address;
  usdc: Address;
  borrower: Address;
  rescuer: Address;
  /** Collateral mode: what the helper may sell, and the helper itself. */
  collateral?: { asset: Address; helper: Address };
}

/** A QuoterV2 `quoteExactOutputSingle` for selling `tokenIn` to receive `amount`. */
export interface SaleQuote {
  tokenIn: Address;
  tokenOut: Address;
  /** Exactly this much `tokenOut`, in its base units. */
  amount: bigint;
  /** Uniswap v3 fee tier, hundredths of a basis point. */
  fee: bigint;
}

export interface EvmReceipt {
  success: boolean;
  blockNumber: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  /** Absent where a caller had no use for them. */
  logs?: EvmLog[];
}

/** A call replayed with `eth_call`, to read why the real one reverted. */
export interface SimulatedCall {
  from: Address;
  to: Address;
  data: Hex;
  gas: bigint;
}

export type SimulationResult =
  | { reverted: false }
  | { reverted: true; data: Hex | null; error: string };

export interface EvmTransaction {
  hash: Hex;
  from: Address;
  to: Address | null;
  input: Hex;
  value: bigint;
  chainId: number;
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  type: string;
  blockNumber: bigint | null;
}

/** The narrow surface the keeper needs, which tests can wrap or replace. */
export interface EvmClient {
  readonly url: string;
  readSample(query: PositionQuery): Promise<Sample>;
  readHealthFactor(pool: Address, borrower: Address, blockNumber?: bigint): Promise<bigint>;
  /** Aave's oracle prices for `assets`, in order, at `blockNumber`. */
  readAssetPrices(pool: Address, assets: Address[], blockNumber: bigint): Promise<bigint[]>;
  /** What `borrower` set at the helper with `authorize`. */
  readHelperConfig(helper: Address, borrower: Address): Promise<HelperConfig>;
  /** QuoterV2's `amountIn` for the sale, at the latest block. */
  quoteExactOutput(quoter: Address, sale: SaleQuote): Promise<bigint>;
  /** Runs `call` against the state at `blockNumber`, and returns any revert data. */
  simulate(call: SimulatedCall, blockNumber: bigint): Promise<SimulationResult>;
  readNonce(address: Address): Promise<number>;
  readFees(): Promise<FeeQuote>;
  broadcast(serialized: Hex): Promise<Hex>;
  readReceipt(hash: Hex): Promise<EvmReceipt | null>;
  readTransaction(hash: Hex): Promise<EvmTransaction | null>;
}

interface AaveWiring {
  oracle: Address;
  variableDebtToken: Address;
}

async function readWiring(client: PublicClient, query: PositionQuery): Promise<AaveWiring> {
  const [provider, reserve] = await client.multicall({
    multicallAddress: MULTICALL3,
    allowFailure: false,
    contracts: [
      { address: query.pool, abi: POOL_ABI, functionName: 'ADDRESSES_PROVIDER' },
      { address: query.pool, abi: POOL_ABI, functionName: 'getReserveData', args: [query.usdc] },
    ],
  });
  const oracle = await client.readContract({
    address: provider,
    abi: PROVIDER_ABI,
    functionName: 'getPriceOracle',
  });
  return { oracle, variableDebtToken: reserve.variableDebtTokenAddress };
}

async function oracleOf(client: PublicClient, pool: Address): Promise<Address> {
  const provider = await client.readContract({
    address: pool,
    abi: POOL_ABI,
    functionName: 'ADDRESSES_PROVIDER',
  });
  return client.readContract({ address: provider, abi: PROVIDER_ABI, functionName: 'getPriceOracle' });
}

/** Aave's `ReserveConfigurationMap`: liquidation threshold at bits 16 to 31. */
export const liquidationThresholdOf = (configuration: bigint): bigint =>
  (configuration >> 16n) & 0xffffn;

/** Aave's `ReserveConfigurationMap`: decimals at bits 48 to 55. */
export const decimalsOf = (configuration: bigint): bigint => (configuration >> 48n) & 0xffn;

/** The revert data in a failed call, wherever viem put it in the error chain. */
function revertDataOf(error: unknown): Hex | null {
  if (!(error instanceof BaseError)) return null;
  const found = error.walk((cause) => {
    const data = (cause as { data?: unknown }).data;
    return typeof data === 'string' || typeof (data as { data?: unknown })?.data === 'string';
  }) as { data?: Hex | { data?: Hex } } | null;
  const data = found?.data;
  const hex = typeof data === 'string' ? data : data?.data;
  return hex && /^0x[0-9a-fA-F]*$/.test(hex) ? hex : null;
}

/** The eMode terms Aave applies to `borrower`, or null outside eMode. */
async function readEMode(
  client: PublicClient,
  pool: Address,
  category: bigint,
  blockNumber: bigint,
): Promise<EModeTerms | null> {
  if (category === 0n) return null;
  const id = Number(category);
  const [bitmap, config, ltvzero, isolated] = await client.multicall({
    multicallAddress: MULTICALL3,
    allowFailure: true,
    blockNumber,
    contracts: [
      { address: pool, abi: EMODE_ABI, functionName: 'getEModeCategoryCollateralBitmap', args: [id] },
      { address: pool, abi: EMODE_ABI, functionName: 'getEModeCategoryCollateralConfig', args: [id] },
      { address: pool, abi: EMODE_ABI, functionName: 'getEModeCategoryLtvzeroBitmap', args: [id] },
      { address: pool, abi: EMODE_ABI, functionName: 'getIsEModeCategoryIsolated', args: [id] },
    ],
  });
  // Before v3.2 eMode had no per-asset bitmaps. The reserve LTVs then stand.
  if (bitmap.status !== 'success' || config.status !== 'success') return null;
  return {
    category,
    collateralBitmap: bitmap.result,
    ltv: BigInt(config.result.ltv),
    ltvzeroBitmap: ltvzero.status === 'success' ? ltvzero.result : 0n,
    isolated: isolated.status === 'success' ? isolated.result : false,
  };
}

/**
 * Reads what Aave's LTV-0 rule needs, at `blockNumber`, and returns the collateral that
 * would block `asset` from leaving the account, or null. See `src/ltv.ts`.
 */
export async function readLtvZeroBlocker(
  client: PublicClient,
  pool: Address,
  borrower: Address,
  asset: Address,
  blockNumber: bigint,
): Promise<Address | null> {
  const [reserves, userConfiguration, category] = await client.multicall({
    multicallAddress: MULTICALL3,
    allowFailure: false,
    blockNumber,
    contracts: [
      { address: pool, abi: POOL_ABI, functionName: 'getReservesList' },
      { address: pool, abi: POOL_ABI, functionName: 'getUserConfiguration', args: [borrower] },
      { address: pool, abi: POOL_ABI, functionName: 'getUserEMode', args: [borrower] },
    ],
  });
  const indexes = collateralIndexes(reserves.length, userConfiguration.data);
  const configurations = await client.multicall({
    multicallAddress: MULTICALL3,
    allowFailure: false,
    blockNumber,
    contracts: indexes.map((index) => ({
      address: pool,
      abi: POOL_ABI,
      functionName: 'getConfiguration' as const,
      args: [reserves[index] as Address] as const,
    })),
  });
  const account: AccountLtv = {
    reserves,
    userConfiguration: userConfiguration.data,
    reserveLtvBps: new Map(
      indexes.map((index, i) => [index, ltvOf(configurations[i]?.data ?? 0n)] as const),
    ),
    eMode: await readEMode(client, pool, category, blockNumber),
  };
  return ltvZeroBlocker(asset, account);
}

async function readCollateral(
  client: PublicClient,
  query: PositionQuery & { collateral: NonNullable<PositionQuery['collateral']> },
  oracle: Address,
  blockNumber: bigint,
): Promise<CollateralSample> {
  const { asset, helper } = query.collateral;
  const [reserve, priceBase, config] = await client.multicall({
    multicallAddress: MULTICALL3,
    allowFailure: false,
    blockNumber,
    contracts: [
      { address: query.pool, abi: POOL_ABI, functionName: 'getReserveData', args: [asset] },
      { address: oracle, abi: ORACLE_ABI, functionName: 'getAssetPrice', args: [asset] },
      {
        address: helper,
        abi: HELPER_CONFIG_VIEW.abi,
        functionName: HELPER_CONFIG_VIEW.functionName,
        args: [query.borrower],
      },
    ],
  });
  const ltvZeroCollateral = await readLtvZeroBlocker(
    client,
    query.pool,
    query.borrower,
    asset,
    blockNumber,
  );
  const aToken = reserve.aTokenAddress;
  const [aTokenBalance, aTokenAllowance] = await client.multicall({
    multicallAddress: MULTICALL3,
    allowFailure: false,
    blockNumber,
    contracts: [
      { address: aToken, abi: ERC20_ABI, functionName: 'balanceOf', args: [query.borrower] },
      { address: aToken, abi: ERC20_ABI, functionName: 'allowance', args: [query.borrower, helper] },
    ],
  });
  const helperConfig = helperConfigFrom(config);
  return {
    priceBase,
    decimals: decimalsOf(reserve.configuration.data),
    liquidationThresholdBps: liquidationThresholdOf(reserve.configuration.data),
    aTokenBalance,
    aTokenAllowance,
    authorizedRescuer: helperConfig.rescuer,
    maxSlippageBps: helperConfig.maxSlippageBps,
    triggerHf: helperConfig.triggerHf,
    targetHf: helperConfig.targetHf,
    authorizedCollateral: helperConfig.collateral,
    authorizedPoolFee: helperConfig.poolFee,
    ltvZeroCollateral,
  };
}

const notFound = (error: unknown): boolean =>
  error instanceof Error && error.name.endsWith('NotFoundError');

/** Short, because a slow endpoint must not delay the five second loop. */
const DEFAULT_RPC_TIMEOUT_MS = 4_000;

export function createEvmClient(
  url: string,
  options: { timeoutMs?: number } = {},
): EvmClient {
  const client: PublicClient = createPublicClient({
    transport: http(url, {
      timeout: options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS,
      retryCount: 1,
    }),
  });

  let wiring: Promise<AaveWiring> | undefined;
  const aaveWiring = (query: PositionQuery): Promise<AaveWiring> => {
    wiring ??= readWiring(client, query).catch((error) => {
      wiring = undefined;
      throw error;
    });
    return wiring;
  };

  return {
    url,

    async readSample(query) {
      const [chainId, block, { oracle, variableDebtToken }] = await Promise.all([
        client.getChainId(),
        client.getBlock({ blockTag: 'latest' }),
        aaveWiring(query),
      ]);
      // One multicall at one block, so that the numbers are consistent with each other.
      const [account, usdcPriceBase, usdcDebt, rescuerUsdc, rescuerAllowance] =
        await client.multicall({
          multicallAddress: MULTICALL3,
          allowFailure: false,
          blockNumber: block.number,
          contracts: [
            {
              address: query.pool,
              abi: POOL_ABI,
              functionName: 'getUserAccountData',
              args: [query.borrower],
            },
            {
              address: oracle,
              abi: ORACLE_ABI,
              functionName: 'getAssetPrice',
              args: [query.usdc],
            },
            {
              address: variableDebtToken,
              abi: ERC20_ABI,
              functionName: 'balanceOf',
              args: [query.borrower],
            },
            {
              address: query.usdc,
              abi: ERC20_ABI,
              functionName: 'balanceOf',
              args: [query.rescuer],
            },
            {
              address: query.usdc,
              abi: ERC20_ABI,
              functionName: 'allowance',
              args: [query.rescuer, query.pool],
            },
          ],
        });
      const [totalCollateralBase, totalDebtBase, , currentLiquidationThreshold, , healthFactor] =
        account;
      const { collateral } = query;
      const collateralSample = collateral
        ? await readCollateral(client, { ...query, collateral }, oracle, block.number)
        : undefined;
      return {
        rpc: url,
        chainId,
        blockNumber: block.number,
        blockTimestamp: block.timestamp,
        healthFactor,
        totalCollateralBase,
        totalDebtBase,
        liquidationThresholdBps: currentLiquidationThreshold,
        usdcPriceBase,
        usdcDebt,
        rescuerUsdc,
        rescuerAllowance,
        ...(collateralSample ? { collateral: collateralSample } : {}),
      };
    },

    async readAssetPrices(pool, assets, blockNumber) {
      const oracle = await oracleOf(client, pool);
      const prices = await client.readContract({
        address: oracle,
        abi: ORACLE_ABI,
        functionName: 'getAssetsPrices',
        args: [assets],
        blockNumber,
      });
      return [...prices];
    },

    async readHelperConfig(helper, borrower) {
      const result = await client.readContract({
        address: helper,
        abi: HELPER_CONFIG_VIEW.abi,
        functionName: HELPER_CONFIG_VIEW.functionName,
        args: [borrower],
      });
      return helperConfigFrom(result);
    },

    async quoteExactOutput(quoter, sale) {
      const [amountIn] = await client.readContract({
        address: quoter,
        abi: QUOTER_V2_ABI,
        functionName: 'quoteExactOutputSingle',
        args: [
          {
            tokenIn: sale.tokenIn,
            tokenOut: sale.tokenOut,
            amount: sale.amount,
            fee: Number(sale.fee),
            sqrtPriceLimitX96: 0n,
          },
        ],
        blockTag: 'latest',
      });
      return amountIn;
    },

    async simulate(call, blockNumber) {
      try {
        await client.call({
          account: call.from,
          to: call.to,
          data: call.data,
          gas: call.gas,
          blockNumber,
        });
        return { reverted: false };
      } catch (error) {
        const message = error instanceof BaseError ? error.shortMessage : String(error);
        return { reverted: true, data: revertDataOf(error), error: message };
      }
    },

    async readHealthFactor(pool, borrower, blockNumber) {
      const account = await client.readContract({
        address: pool,
        abi: POOL_ABI,
        functionName: 'getUserAccountData',
        args: [borrower],
        ...(blockNumber === undefined ? {} : { blockNumber }),
      });
      return account[5];
    },

    readNonce: (address) => client.getTransactionCount({ address, blockTag: 'pending' }),

    async readFees() {
      const [block, priorityFeePerGas] = await Promise.all([
        client.getBlock({ blockTag: 'latest' }),
        client.estimateMaxPriorityFeePerGas(),
      ]);
      if (block.baseFeePerGas === null) throw new Error('block has no base fee');
      return { baseFeePerGas: block.baseFeePerGas, priorityFeePerGas };
    },

    broadcast: (serialized) => client.sendRawTransaction({ serializedTransaction: serialized }),

    async readReceipt(hash) {
      try {
        const receipt = await client.getTransactionReceipt({ hash });
        return {
          success: receipt.status === 'success',
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed,
          effectiveGasPrice: receipt.effectiveGasPrice,
          logs: receipt.logs.map((log) => ({
            address: getAddress(log.address),
            topics: [...log.topics],
            data: log.data,
          })),
        };
      } catch (error) {
        if (notFound(error)) return null;
        throw error;
      }
    },

    async readTransaction(hash) {
      try {
        const tx = await client.getTransaction({ hash });
        return {
          hash: tx.hash,
          from: tx.from,
          to: tx.to,
          input: tx.input,
          value: tx.value,
          chainId: tx.chainId ?? 0,
          nonce: tx.nonce,
          gas: tx.gas,
          maxFeePerGas: tx.maxFeePerGas ?? 0n,
          maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? 0n,
          type: tx.type,
          blockNumber: tx.blockNumber,
        };
      } catch (error) {
        if (notFound(error)) return null;
        throw error;
      }
    },
  };
}
