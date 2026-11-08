/** In-memory stand-ins for the EVM and NEAR sides of a rescue. */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Address,
  type Hex,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  parseAbiItem,
} from 'viem';
import { CHAINS } from '../../src/chains.js';
import { parseWad } from '../../src/decision.js';
import { runsDir } from '../../src/evidence.js';
import type { EvmClient, EvmReceipt, SaleQuote, SimulationResult } from '../../src/evm.js';
import type { NearRescuer, Position, RescueRequest } from '../../src/near.js';
import type { CollateralSample, Sample } from '../../src/quorum.js';
import type { PositionTarget, RescueContext } from '../../src/rescue.js';
import { type EvmLog, type HelperConfig, unwindCalldata } from '../../src/unwind.js';
import { createSimulatedMpc, repayCalldata, unsignedTransaction } from './simulated-mpc.js';

export const chain = CHAINS[8453] as NonNullable<(typeof CHAINS)[8453]>;
export const borrower: Address = '0x1111111111111111111111111111111111111111';
export const nowMs = 1_800_000_000_000;

export const positionTarget: PositionTarget = {
  id: 1,
  trigger: '1.25',
  target: '1.6',
  triggerWad: parseWad('1.25'),
  targetWad: parseWad('1.6'),
};

/** Health factor 1.142857: $20,000 at 80% against $14,000. */
export const sickSample = (rpc: string, over: Partial<Sample> = {}): Sample => ({
  rpc,
  chainId: 8453,
  blockNumber: 1_000n,
  blockTimestamp: BigInt(nowMs / 1000 - 2),
  healthFactor: 1_142_857_142_857_142_857n,
  totalCollateralBase: 20_000n * 10n ** 8n,
  totalDebtBase: 14_000n * 10n ** 8n,
  liquidationThresholdBps: 8_000n,
  usdcPriceBase: 10n ** 8n,
  usdcDebt: 14_000n * 10n ** 6n,
  rescuerUsdc: 10_000n * 10n ** 6n,
  rescuerAllowance: 100_000n * 10n ** 6n,
  ...over,
});

export const healthySample = (rpc: string): Sample =>
  sickSample(rpc, { healthFactor: parseWad('1.9') });

/** Stands in for `LeveeUnwind`. */
export const helper: Address = '0x5555555555555555555555555555555555555555';
/** WETH on Base. */
export const weth: Address = '0x4200000000000000000000000000000000000006';
export const poolFee = 500n;
export const wethPrice = 2_000n * 10n ** 8n;
/** Stands in for QuoterV2. */
export const quoter: Address = '0x7777777777777777777777777777777777777777';

/** The keeper's collateral-mode settings, which the borrower's at the helper match. */
export const collateralTarget: PositionTarget = {
  ...positionTarget,
  mode: 'collateral',
  maxSlippageBps: 100n,
};

/**
 * The sick position's $20,000 of collateral as 10 WETH at $2,000, all of it approved to
 * the helper, which the borrower authorized for `rescuer` at 1.25, 1.6 and 1%.
 */
export const collateralOf = (
  rescuer: Address,
  over: Partial<CollateralSample> = {},
): CollateralSample => ({
  priceBase: wethPrice,
  decimals: 18n,
  liquidationThresholdBps: 8_000n,
  aTokenBalance: 10n * 10n ** 18n,
  aTokenAllowance: 10n * 10n ** 18n,
  authorizedRescuer: rescuer,
  maxSlippageBps: 100n,
  triggerHf: parseWad('1.25'),
  targetHf: parseWad('1.6'),
  authorizedCollateral: weth,
  authorizedPoolFee: poolFee,
  ltvZeroCollateral: null,
  ...over,
});

export const helperConfigOf = (sample: CollateralSample): HelperConfig => ({
  rescuer: sample.authorizedRescuer,
  maxSlippageBps: sample.maxSlippageBps,
  triggerHf: sample.triggerHf,
  targetHf: sample.targetHf,
  collateral: sample.authorizedCollateral,
  poolFee: sample.authorizedPoolFee,
});

const UNWOUND_ALL_INDEXED = parseAbiItem(
  'event Unwound(address indexed borrower, address indexed rescuer, address indexed collateral, uint256 repaid, uint256 sold)',
);

/** An `Unwound` log as the helper would emit it, encoded by viem from the ABI. */
export function unwoundLog(fields: {
  borrower: Address;
  rescuer: Address;
  collateral: Address;
  repaid: bigint;
  sold: bigint;
  address?: Address;
}): EvmLog {
  return {
    address: fields.address ?? helper,
    topics: encodeEventTopics({
      abi: [UNWOUND_ALL_INDEXED],
      args: { borrower: fields.borrower, rescuer: fields.rescuer, collateral: fields.collateral },
    }) as Hex[],
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }],
      [fields.repaid, fields.sold],
    ),
  };
}

export const openPosition = (over: Partial<Position> = {}): Position => ({
  owner: 'owner.testnet',
  keeper: 'keeper.testnet',
  chain_id: 8453,
  borrower,
  max_per_rescue: 5_000n * 10n ** 6n,
  max_per_day: 10_000n * 10n ** 6n,
  cooldown_secs: 600,
  paused: false,
  spent_today: 0n,
  day: BigInt(Math.floor(nowMs / 86_400_000)),
  last_rescue_at: 0n,
  ...over,
});

export interface FakeEvm extends EvmClient {
  sample: Sample | Error;
  broadcasts: Hex[];
  broadcastError: Error | null;
  receipt: EvmReceipt | null;
  healthAfter: bigint | Error;
  /** Collateral, then USDC. */
  prices: bigint[] | Error;
  /** Defaults to what the sample says the helper holds. */
  helperConfig: HelperConfig | Error | null;
  simulation: SimulationResult | Error;
  /** QuoterV2's answer. By default the price of COLLATERAL_SALE, for any amount. */
  quote: bigint | Error | ((sale: SaleQuote) => bigint);
  quotes: SaleQuote[];
}

export function fakeEvm(url: string, sample: Sample | Error = sickSample(url)): FakeEvm {
  const fake: FakeEvm = {
    url,
    sample,
    broadcasts: [],
    broadcastError: null,
    receipt: { success: true, blockNumber: 1_001n, gasUsed: 180_000n, effectiveGasPrice: 2_000n },
    healthAfter: parseWad('1.6'),
    prices: [wethPrice, 10n ** 8n],
    helperConfig: null,
    simulation: { reverted: false },
    quote: (sale) => (sale.amount * COLLATERAL_SALE.sold) / COLLATERAL_SALE.repaid,
    quotes: [],
    async quoteExactOutput(_quoter, sale) {
      fake.quotes.push(sale);
      if (fake.quote instanceof Error) throw fake.quote;
      return typeof fake.quote === 'function' ? fake.quote(sale) : fake.quote;
    },
    async readSample() {
      if (fake.sample instanceof Error) throw fake.sample;
      return fake.sample;
    },
    async readHealthFactor() {
      if (fake.healthAfter instanceof Error) throw fake.healthAfter;
      return fake.healthAfter;
    },
    async readAssetPrices() {
      if (fake.prices instanceof Error) throw fake.prices;
      return fake.prices;
    },
    async readHelperConfig() {
      if (fake.helperConfig instanceof Error) throw fake.helperConfig;
      if (fake.helperConfig) return fake.helperConfig;
      if (fake.sample instanceof Error || !fake.sample.collateral) {
        throw new Error('no helper config');
      }
      return helperConfigOf(fake.sample.collateral);
    },
    async simulate() {
      if (fake.simulation instanceof Error) throw fake.simulation;
      return fake.simulation;
    },
    readNonce: async () => 4,
    readFees: async () => ({ baseFeePerGas: 1_000n, priorityFeePerGas: 100n }),
    async broadcast(serialized) {
      fake.broadcasts.push(serialized);
      if (fake.broadcastError) throw fake.broadcastError;
      return keccak256(serialized);
    },
    readReceipt: async () => fake.receipt,
    readTransaction: async () => null,
  };
  return fake;
}

export interface FakeNear extends NearRescuer {
  requests: RescueRequest[];
}

/** Builds and signs what the contract would, using the simulated MPC key. */
export function fakeNear(
  mpc: ReturnType<typeof createSimulatedMpc>,
  behaviour: {
    fail?: Error;
    tamper?: (fields: Parameters<typeof unsignedTransaction>[0]) => void;
    nearTx?: string;
    borrower?: Address;
    /** Collateral mode: what the contract would put in `unwind`. */
    collateral?: Address;
    poolFee?: bigint;
    maxSold?: bigint;
    /** The clock to stamp with, for a caller on real time. */
    now?: () => number;
  } = {},
): FakeNear {
  const requests: RescueRequest[] = [];
  return {
    requests,
    async rescue(request) {
      requests.push(request);
      if (behaviour.fail) throw behaviour.fail;
      const onBehalfOf = behaviour.borrower ?? borrower;
      const unwind = request.mode === 'collateral';
      const fields = {
        chainId: chain.chainId,
        nonce: request.fees.nonce,
        maxFeePerGas: request.fees.maxFeePerGas,
        maxPriorityFeePerGas: request.fees.maxPriorityFeePerGas,
        to: unwind ? helper : chain.pool,
        data: unwind
          ? unwindCalldata({
              borrower: onBehalfOf,
              collateral: behaviour.collateral ?? weth,
              amount: request.amount,
              poolFee: behaviour.poolFee ?? poolFee,
              maxSold: behaviour.maxSold ?? (request.maxSold as bigint),
            })
          : repayCalldata(chain.usdc, request.amount, 2n, onBehalfOf),
        ...(unwind ? { gas: 600_000n } : {}),
      };
      behaviour.tamper?.(fields);
      return {
        nearTx: behaviour.nearTx ?? 'SimulatedNearTxHash',
        nearSender: 'keeper.testnet',
        includedAtMs: behaviour.now?.() ?? nowMs + 1_000,
        signedAtMs: behaviour.now?.() ?? nowMs + 4_000,
        result: mpc.sign(unsignedTransaction(fields), request.id, unwind ? 'unwind' : 'rescue'),
      };
    },
  };
}

export interface Harness {
  ctx: RescueContext;
  mpc: ReturnType<typeof createSimulatedMpc>;
  a: FakeEvm;
  b: FakeEvm;
  near: FakeNear;
  evidenceDir: string;
  runFiles(): Promise<string[]>;
  cleanup(): Promise<void>;
}

export async function harness(over: Partial<RescueContext> = {}): Promise<Harness> {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'levee-evidence-'));
  const mpc = createSimulatedMpc();
  const a = fakeEvm('https://a.invalid');
  const b = fakeEvm('https://b.invalid');
  const near = fakeNear(mpc);
  let clock = nowMs;
  const ctx: RescueContext = {
    network: 'simulated',
    chain,
    position: positionTarget,
    borrower,
    rescuer: mpc.address,
    nearContract: 'levee.testnet',
    clients: [a, b],
    near,
    views: { getPosition: async () => openPosition() },
    ceilings: { maxFeePerGas: 10_000_000n, maxPriorityFeePerGas: 1_000_000n },
    evidenceDir,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    log: () => {},
    receiptTimeoutMs: 5_000,
    receiptPollMs: 1_000,
    ...over,
  };
  return {
    ctx,
    mpc,
    a,
    b,
    near,
    evidenceDir,
    async runFiles() {
      return readdir(runsDir(evidenceDir)).catch(() => []);
    },
    cleanup: () => rm(evidenceDir, { recursive: true, force: true }),
  };
}

/**
 * A harness in collateral mode: the contract signs `unwind`, both endpoints read the
 * collateral and the helper's settings, and the receipt carries the helper's event for
 * a sale of 5,000 USDC, the position's `max_per_rescue`, at 0.3% below the oracle.
 */
export async function collateralHarness(over: Partial<RescueContext> = {}): Promise<Harness> {
  const h = await harness({
    position: collateralTarget,
    collateral: { asset: weth, helper, poolFee, quoter },
    ...over,
  });
  for (const client of [h.a, h.b]) {
    client.sample = sickSample(client.url, { collateral: collateralOf(h.mpc.address) });
    client.receipt = {
      success: true,
      blockNumber: 1_001n,
      gasUsed: 420_000n,
      effectiveGasPrice: 2_000n,
      logs: [
        unwoundLog({
          borrower,
          rescuer: h.mpc.address,
          collateral: weth,
          repaid: COLLATERAL_SALE.repaid,
          sold: COLLATERAL_SALE.sold,
        }),
      ],
    };
  }
  return h;
}

/** 5,000 USDC for 2.5075 WETH: $1,994.0179 each against an oracle at $2,000. */
export const COLLATERAL_SALE = {
  repaid: 5_000n * 10n ** 6n,
  sold: 2_507_500_000_000_000_000n,
} as const;

/** The keeper's cap for that sale: the quote plus the default 50 bps, rounded down. */
export const COLLATERAL_MAX_SOLD = (COLLATERAL_SALE.sold * 10_050n) / 10_000n;
