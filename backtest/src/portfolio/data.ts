// The committed population files. `derive-portfolio` writes them from data/raw; `pnpm backtest`
// reads them. One file per chain and period. Columns are delta-coded where that compresses.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { ChainKey } from '../config.ts';
import type { WindowPrices } from '../data.ts';
import { DERIVED_DIR } from '../paths.ts';

export const PORTFOLIO_DIR = join(DERIVED_DIR, 'portfolio');
export const CALM_PRICES_FILE = join(PORTFOLIO_DIR, 'prices-calm.json.gz');
export const SAMPLE_FILE = join(PORTFOLIO_DIR, 'sample.json.gz');
export const populationFile = (chain: ChainKey, period: string): string => join(PORTFOLIO_DIR, `${chain}-${period}.json.gz`);

/** Indexes are stored as integers of 1e-13, which keeps them exact to well under 1e-9. */
export const INDEX_UNIT = 1e13;

export const ReadCode = {
  Start: 0,
  /** A grid re-read of the reserves a member touched. */
  Partial: 1,
  /** A newcomer's first read, on the grid. */
  Joined: 2,
  /** The block before a first liquidation. */
  BeforeLiquidation: 3,
} as const;

export interface PopulationFile {
  chain: ChainKey;
  period: string;
  fromBlock: number;
  toBlock: number;
  fromTime: number;
  toTime: number;
  /** Reserve order shared with the period's price file and market snapshot. */
  assets: string[];
  usdc: number;
  census: {
    candidates: number;
    startMembers: number;
    newcomers: number;
    /** USDC variable debt token, raw units, at the first block. */
    totalSupply: string;
    sumOfStartBalances: string;
  };
  /** Hourly. Per asset, normalized income and variable debt index in INDEX_UNIT, delta-coded. */
  index: { t: number[]; income: number[][]; debt: number[][] };
  /** Hourly USDC supply and variable borrow APR, in 1e-8. */
  usdcRates: { t: number[]; supplyApr: number[]; borrowApr: number[] };
  /** Start members sorted, then newcomers sorted. */
  members: string[];
  /** Members liquidated in the period and not in the headline set: first liquidation, first-episode gross bonus. */
  liquidations: Array<[member: number, block: number, t: number, bonusUsd: number, events: number]>;
  /** Members whose path and outcome come from the headline set. */
  headline: number[];
  /** One row per read, sorted by member, then by the block the read applies from. */
  reads: {
    member: number[];
    /** Block the state applies from, delta-coded within a member. */
    applyBlock: number[];
    applyT: number[];
    /** Read block minus applyBlock, and its time minus applyT. */
    readLag: number[];
    readLagT: number[];
    code: number[];
    emode: number[];
    /** getUserAccountData HF at the read block, × 1e4, or -1 with no debt. */
    hf: number[];
    /** Balance entries in this read. */
    n: number[];
  };
  /** Flattened balance entries: asset index, scaled supply and scaled variable debt in whole tokens, used as collateral. */
  balances: { asset: number[]; supply: number[]; debt: number[]; collateral: number[] };
}

/** getUserAccountData at sampled member and block pairs, for validation. */
export interface SampleFile {
  rows: Array<{
    chain: ChainKey;
    period: string;
    block: number;
    t: number;
    /** Member index into the population file, the stratum (0 random, 1 rebuilt HF 1.0 to 1.4), HF × 1e6 or -1, debt USD. */
    reads: Array<[member: number, stratum: number, hf: number, debtUsd: number]>;
  }>;
}

export function writeGz(path: string, value: unknown): void {
  writeFileSync(path, gzipSync(JSON.stringify(value), { level: 9 }));
}

export function readGz<T>(path: string): T {
  return JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as T;
}

export const readPopulation = (chain: ChainKey, period: string): PopulationFile => readGz<PopulationFile>(populationFile(chain, period));
export const readCalmPrices = (): WindowPrices[] => readGz<WindowPrices[]>(CALM_PRICES_FILE);
