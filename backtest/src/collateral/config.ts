// Repay from collateral: the pinned inputs. The rules are in README.md, "Method: repay from
// collateral", committed before any of this code existed.
import type { ChainKey } from '../config.ts';

/** Uniswap v3 on each chain. Each QuoterV2's `factory()` returned the factory beside it on 2026-11-08. */
export const UNISWAP: Record<ChainKey, { factory: `0x${string}`; quoter: `0x${string}` }> = {
  base: { factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a' },
  arbitrum: { factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984', quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e' },
};

export const FEE_TIERS = [100, 500, 3000, 10000] as const;

/** A tier is usable if a quote for this many USDC out, at the period's first block, is within PROBE_MAX_BPS of AaveOracle. */
export const PROBE_USDC = 1_000;
export const PROBE_MAX_BPS = 300;

/** The `max_slippage_bps` grid. The spec allows 1 to 300. */
export const SLIPPAGE_BPS = [100, 300] as const;

/** An unwind smaller than this many USD is not sent. */
export const MIN_UNWIND_USD = 1;

/** Gas charged to every unwind sent, landed or reverted: the top of the spec's 350k to 600k estimate. */
export const GAS_PER_UNWIND = 600_000;

/** Quotes are taken at 10^(k / STEPS) USDC, for k from 0 to LADDER_TOP. */
export const LADDER_STEPS_PER_DECADE = 8;
export const LADDER_TOP = 64;

/** USDC base units for each ladder point, fixed once so every reader uses the same amounts. */
export const LADDER: number[] = Array.from({ length: LADDER_TOP + 1 }, (_, k) => Math.round(10 ** (k / LADDER_STEPS_PER_DECADE) * 1e6));

/** Costs are stored relative to the oracle in units of 1e-7: 0.001 bps. */
export const COST_UNIT = 1e7;

/** No member that stays at or above this HF and is not liquidated can unwind at any trigger in the grid. */
export const HIGHEST_TRIGGER = 1.3;

/**
 * Repeat reverts: after this many reverts in a row, each quoted at its landing block, a run's further
 * unwinds in the same UTC hour as its last quoted one are taken to revert the same way. README.md.
 */
export const REPEAT_REVERTS_PRICED = 5;
export const REPEAT_WINDOW_SEC = 3_600;

/** Seed for every validation draw. */
export const VALIDATION_SEED = 20_261_108;
