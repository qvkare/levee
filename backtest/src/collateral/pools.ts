// The usable Uniswap v3 pools against native USDC, per chain and period. `fetch-pools` writes the
// file from the chain; `pnpm backtest` reads it. Rules in README.md, "Method: repay from collateral".
import { join } from 'node:path';
import type { ChainKey } from '../config.ts';
import { DERIVED_DIR, readJson } from '../paths.ts';

export const COLLATERAL_DIR = join(DERIVED_DIR, 'collateral');
export const POOLS_FILE = join(COLLATERAL_DIR, 'pools.json');

export interface PoolTier {
  fee: number;
  pool: string;
  /** Native USDC held by the pool at the period's first block, in USDC. */
  usdcBalance: number;
  /** Cost of the 1,000 USDC probe against AaveOracle, in bps, or null if the quote failed. */
  probeCostBps: number | null;
  usable: boolean;
}

export interface AssetPools {
  /** Index into the period's price file and population file. */
  asset: number;
  address: string;
  symbol: string;
  decimals: number;
  /** Every fee tier with a pool, usable or not. */
  tiers: PoolTier[];
  /** The usable tier whose pool held the most USDC, or null if none is usable. */
  configuredFee: number | null;
}

export interface PeriodPools {
  chain: ChainKey;
  period: string;
  block: number;
  /** AaveOracle's USDC price at that block, 8 decimals. */
  usdcPrice: number;
  /** Every reserve with a threshold above zero other than native USDC, in price-file order. */
  assets: AssetPools[];
}

export const readPools = (): PeriodPools[] => readJson<PeriodPools[]>(POOLS_FILE);

/** Usable tiers of an asset in a period, in fee order. */
export function usableTiers(pools: PeriodPools, asset: number): PoolTier[] {
  return pools.assets.find((a) => a.asset === asset)?.tiers.filter((t) => t.usable) ?? [];
}
