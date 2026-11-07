/** In-memory stand-ins for the EVM and NEAR sides of a rescue. */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Address, type Hex, keccak256 } from 'viem';
import { CHAINS } from '../../src/chains.js';
import { parseWad } from '../../src/decision.js';
import { runsDir } from '../../src/evidence.js';
import type { EvmClient, EvmReceipt } from '../../src/evm.js';
import type { NearRescuer, Position, RescueRequest } from '../../src/near.js';
import type { Sample } from '../../src/quorum.js';
import type { PositionTarget, RescueContext } from '../../src/rescue.js';
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
}

export function fakeEvm(url: string, sample: Sample | Error = sickSample(url)): FakeEvm {
  const fake: FakeEvm = {
    url,
    sample,
    broadcasts: [],
    broadcastError: null,
    receipt: { success: true, blockNumber: 1_001n, gasUsed: 180_000n, effectiveGasPrice: 2_000n },
    healthAfter: parseWad('1.6'),
    async readSample() {
      if (fake.sample instanceof Error) throw fake.sample;
      return fake.sample;
    },
    async readHealthFactor() {
      if (fake.healthAfter instanceof Error) throw fake.healthAfter;
      return fake.healthAfter;
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
      const fields = {
        chainId: chain.chainId,
        nonce: request.fees.nonce,
        maxFeePerGas: request.fees.maxFeePerGas,
        maxPriorityFeePerGas: request.fees.maxPriorityFeePerGas,
        to: chain.pool,
        data: repayCalldata(chain.usdc, request.amount, 2n, behaviour.borrower ?? borrower),
      };
      behaviour.tamper?.(fields);
      return {
        nearTx: behaviour.nearTx ?? 'SimulatedNearTxHash',
        nearSender: 'keeper.testnet',
        includedAtMs: behaviour.now?.() ?? nowMs + 1_000,
        signedAtMs: behaviour.now?.() ?? nowMs + 4_000,
        result: mpc.sign(unsignedTransaction(fields), request.id),
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
