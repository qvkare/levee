/**
 * Quorum read of a position. Spec section 5: act only if at least two RPC endpoints
 * agree within 0.5% and are less than 30 seconds old. One bad endpoint can therefore
 * stop a rescue but cannot cause one.
 */

import type { Address } from 'viem';

/**
 * Collateral mode only: the collateral, the borrower's hold on it, and what the
 * borrower set at the helper with `authorize`. Read at the sample's block.
 */
export interface CollateralSample {
  /** Aave's oracle price for the collateral, base currency. */
  priceBase: bigint;
  decimals: bigint;
  /** The collateral reserve's own liquidation threshold, basis points. */
  liquidationThresholdBps: bigint;
  aTokenBalance: bigint;
  /** The borrower's aToken allowance to the helper. */
  aTokenAllowance: bigint;
  /** The rescuer the borrower authorized at the helper. Zero once revoked. */
  authorizedRescuer: Address;
  maxSlippageBps: bigint;
  /** Wad. `unwind` reverts unless the health factor is below this. */
  triggerHf: bigint;
  /** Wad. */
  targetHf: bigint;
  /** The collateral the borrower authorized at the helper. Zero once revoked. */
  authorizedCollateral: Address;
  /** The Uniswap v3 fee tier the borrower authorized at the helper. */
  authorizedPoolFee: bigint;
  /**
   * Another collateral enabled in the account at LTV 0, which makes Aave refuse to let
   * this one leave first, so every unwind would revert. Null when there is none.
   */
  ltvZeroCollateral: Address | null;
}

/** One endpoint's view of a position, all read at one block. */
export interface Sample {
  rpc: string;
  chainId: number;
  blockNumber: bigint;
  /** Seconds since the Unix epoch, from the block header. */
  blockTimestamp: bigint;
  healthFactor: bigint;
  totalCollateralBase: bigint;
  totalDebtBase: bigint;
  liquidationThresholdBps: bigint;
  usdcPriceBase: bigint;
  usdcDebt: bigint;
  rescuerUsdc: bigint;
  rescuerAllowance: bigint;
  /** Present in collateral mode. */
  collateral?: CollateralSample;
}

export interface RpcFailure {
  rpc: string;
  error: string;
}

export interface QuorumOptions {
  chainId: number;
  nowMs: number;
  /** Distinct endpoints that must agree. */
  minEndpoints: number;
  /** A sample this old or older does not count. */
  maxAgeSecs: number;
  /** Largest allowed gap between two samples of a field, in basis points of the larger. */
  maxDeviationBps: bigint;
}

export const DEFAULT_QUORUM: Omit<QuorumOptions, 'chainId' | 'nowMs'> = {
  minEndpoints: 2,
  maxAgeSecs: 30,
  maxDeviationBps: 50n,
};

export type QuorumRefusal = 'too_few_rpcs' | 'stale' | 'disagreement';

interface QuorumEvidence {
  samples: Sample[];
  failures: RpcFailure[];
  /** The clock the freshness check used, kept so that `replay` can repeat it. */
  nowMs: number;
}

export type QuorumResult =
  | ({ ok: true; sample: Sample } & QuorumEvidence)
  | ({ ok: false; reason: QuorumRefusal; detail: string } & QuorumEvidence);

/** Every number the decision reads. Comparing only the health factor would let one
 *  endpoint inflate the amount through the debt or the price. */
const COMPARED_FIELDS = [
  'healthFactor',
  'totalCollateralBase',
  'totalDebtBase',
  'liquidationThresholdBps',
  'usdcPriceBase',
  'usdcDebt',
  'rescuerUsdc',
  'rescuerAllowance',
] as const satisfies readonly (keyof Sample)[];

/** Market and balance figures the collateral decision reads. */
const COMPARED_COLLATERAL_FIELDS = [
  'priceBase',
  'liquidationThresholdBps',
  'aTokenBalance',
  'aTokenAllowance',
] as const satisfies readonly (keyof CollateralSample)[];

/** Settings, which are either the same everywhere or something is wrong. */
const EXACT_COLLATERAL_FIELDS = [
  'decimals',
  'authorizedRescuer',
  'maxSlippageBps',
  'triggerHf',
  'targetHf',
  'authorizedCollateral',
  'authorizedPoolFee',
  'ltvZeroCollateral',
] as const satisfies readonly (keyof CollateralSample)[];

function withinDeviation(a: bigint, b: bigint, maxDeviationBps: bigint): boolean {
  const [low, high] = a < b ? [a, b] : [b, a];
  return (high - low) * 10_000n <= high * maxDeviationBps;
}

function spread(values: bigint[], maxDeviationBps: bigint): boolean {
  const low = values.reduce((a, b) => (b < a ? b : a));
  const high = values.reduce((a, b) => (b > a ? b : a));
  return withinDeviation(low, high, maxDeviationBps);
}

function findCollateralDisagreement(samples: Sample[], maxDeviationBps: bigint): string | null {
  const present = samples.filter((sample) => sample.collateral !== undefined);
  if (present.length === 0) return null;
  if (present.length !== samples.length) {
    const seen = samples.map((sample) => `${sample.rpc}=${sample.collateral ? 'yes' : 'no'}`);
    return `collateral read by some endpoints only: ${seen.join(' ')}`;
  }
  const seen = (field: keyof CollateralSample) =>
    samples.map((sample) => `${sample.rpc}=${sample.collateral?.[field]}`).join(' ');
  for (const field of COMPARED_COLLATERAL_FIELDS) {
    const values = present.map((sample) => (sample.collateral as CollateralSample)[field]);
    if (!spread(values, maxDeviationBps)) {
      return `collateral.${field} differs by more than ${maxDeviationBps} bps: ${seen(field)}`;
    }
  }
  for (const field of EXACT_COLLATERAL_FIELDS) {
    const values = present.map((sample) =>
      String((sample.collateral as CollateralSample)[field]).toLowerCase(),
    );
    if (new Set(values).size > 1) return `collateral.${field} differs: ${seen(field)}`;
  }
  return null;
}

function findDisagreement(samples: Sample[], maxDeviationBps: bigint): string | null {
  for (const field of COMPARED_FIELDS) {
    if (!spread(samples.map((sample) => sample[field]), maxDeviationBps)) {
      const seen = samples.map((sample) => `${sample.rpc}=${sample[field]}`).join(' ');
      return `${field} differs by more than ${maxDeviationBps} bps: ${seen}`;
    }
  }
  return findCollateralDisagreement(samples, maxDeviationBps);
}

const ageSecs = (sample: Sample, nowMs: number): number =>
  Math.abs(nowMs / 1000 - Number(sample.blockTimestamp));

/** Keeps the first sample per endpoint, so one endpoint listed twice is still one. */
function distinctEndpoints(samples: Sample[]): Sample[] {
  const seen = new Set<string>();
  return samples.filter((sample) => {
    if (seen.has(sample.rpc)) return false;
    seen.add(sample.rpc);
    return true;
  });
}

/** Pure, so that `replay` can repeat the judgement from recorded samples. */
export function evaluateQuorum(
  rawSamples: Sample[],
  rawFailures: RpcFailure[],
  options: QuorumOptions,
): QuorumResult {
  const samples = distinctEndpoints(rawSamples);
  const failures = [...rawFailures];
  const evidence = { samples, failures, nowMs: options.nowMs };
  const refuse = (reason: QuorumRefusal, detail: string): QuorumResult => ({
    ok: false,
    reason,
    detail,
    ...evidence,
  });

  const onChain = samples.filter((sample) => {
    if (sample.chainId === options.chainId) return true;
    failures.push({ rpc: sample.rpc, error: `serves chain ${sample.chainId}` });
    return false;
  });

  const fresh = onChain.filter((sample) => ageSecs(sample, options.nowMs) < options.maxAgeSecs);

  if (fresh.length < options.minEndpoints) {
    const stale = onChain.length - fresh.length;
    const detail = `${fresh.length} of ${options.minEndpoints} endpoints usable, ${stale} stale, ${failures.length} failed`;
    return refuse(stale > 0 ? 'stale' : 'too_few_rpcs', detail);
  }

  // Every fresh endpoint has a veto. There is no majority: a minority may be the honest one.
  const disagreement = findDisagreement(fresh, options.maxDeviationBps);
  if (disagreement) return refuse('disagreement', disagreement);

  const sample = fresh.reduce((best, next) => (next.blockNumber > best.blockNumber ? next : best));
  return { ok: true, sample, ...evidence };
}

/**
 * Reads every endpoint in parallel and judges the result. The clock is read after the
 * reads finish, so that a slow endpoint cannot make an old block look fresh.
 */
export async function readQuorum(
  endpoints: { url: string; read: () => Promise<Sample> }[],
  options: Omit<QuorumOptions, 'nowMs'>,
  now: () => number,
): Promise<QuorumResult> {
  const settled = await Promise.allSettled(endpoints.map((endpoint) => endpoint.read()));
  const samples: Sample[] = [];
  const failures: RpcFailure[] = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      samples.push(result.value);
    } else {
      const rpc = endpoints[index]?.url ?? 'unknown';
      failures.push({ rpc, error: String(result.reason?.shortMessage ?? result.reason) });
    }
  });
  return evaluateQuorum(samples, failures, { ...options, nowMs: now() });
}
