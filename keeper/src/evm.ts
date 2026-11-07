/** Reads and writes against one EVM RPC endpoint. No decisions are made here. */
import {
  type Address,
  type Hex,
  type PublicClient,
  createPublicClient,
  http,
  parseAbi,
} from 'viem';
import type { FeeQuote } from './fees.js';
import type { Sample } from './quorum.js';

/** Deterministic deployment, present on all four chains in spec section 3. */
const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';

const POOL_ABI = parseAbi([
  'function ADDRESSES_PROVIDER() view returns (address)',
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
  // The newer getReserveVariableDebtToken is missing on Arbitrum Sepolia (revision 3).
  'function getReserveData(address asset) view returns (((uint256 data) configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt) reserve)',
]);

const PROVIDER_ABI = parseAbi(['function getPriceOracle() view returns (address)']);
const ORACLE_ABI = parseAbi(['function getAssetPrice(address asset) view returns (uint256)']);
const ERC20_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

export interface PositionQuery {
  pool: Address;
  usdc: Address;
  borrower: Address;
  rescuer: Address;
}

export interface EvmReceipt {
  success: boolean;
  blockNumber: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
}

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
      };
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
