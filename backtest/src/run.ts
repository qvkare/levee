// `pnpm backtest`: reads the committed derived files and writes results. No network.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHAINS, type ChainKey } from './config.ts';
import { readPositions, readPrices, VALIDATION_FILE, type DerivedPosition } from './data.ts';
import type { MarketSnapshot } from './fetch/reserves.ts';
import { runHyperliquid } from './hyperliquid.ts';
import { DERIVED_DIR, existsSync, readJson, RESULTS_DIR, writeJson } from './paths.ts';
import { renderSummary } from './report/render.ts';
import { buildSummary, type ValidationRow } from './report/summary.ts';

interface ValidationFile {
  pooled: {
    frozenVsDirectAtSnapshot: Record<string, number>;
    frozenVsDirectRunUpWorstPerPosition: Record<string, number>;
    runUpWithin0_5Pct: number;
    frozenHfBelow1AtLiquidation: number;
    frozenHfAtOrAbove1AtLiquidation: number;
    bonusRatioError: Record<string, number>;
  };
}

interface ProvenanceRow {
  chain: string;
  window: string;
  fromBlock: number;
  toBlock: number;
  counts: Record<string, number>;
  union: number;
  confirmedByReceipt: number;
}

const percent = (x: number | undefined, digits = 3): string => `${((x ?? NaN) * 100).toFixed(digits)}%`;

function validationRows(file: ValidationFile, provenance: ProvenanceRow[], crossCheck: { reads: number; mismatches: number; providers: string[]; providerCallsThatFailed: number } | null): ValidationRow[] {
  const p = file.pooled;
  const rows: ValidationRow[] = [];
  for (const row of provenance) {
    const counts = Object.entries(row.counts)
      .map(([host, n]) => `${host} ${n}`)
      .join(', ');
    rows.push({
      check: `LiquidationCall logs, ${row.chain} ${row.window}, blocks ${row.fromBlock} to ${row.toBlock}`,
      result: `${counts}. Union ${row.union}, of which ${row.confirmedByReceipt} confirmed by transaction receipt`,
    });
  }
  if (crossCheck) {
    rows.push({
      check: 'Stored archive reads re-read on other providers',
      result: `${crossCheck.reads} comparisons on ${crossCheck.providers.join(', ')}. ${crossCheck.mismatches} mismatches. ${crossCheck.providerCallsThatFailed} calls refused by a provider and not counted`,
    });
  }
  rows.push({
    check: 'Frozen-portfolio HF against getUserAccountData, block before liquidation',
    result: `median ${percent(p.frozenVsDirectAtSnapshot['median'])}, p95 ${percent(p.frozenVsDirectAtSnapshot['p95'])}, p99 ${percent(p.frozenVsDirectAtSnapshot['p99'])}, max ${percent(p.frozenVsDirectAtSnapshot['max'])}, n=${p.frozenVsDirectAtSnapshot['n']}`,
  });
  rows.push({
    check: 'Same check over the last two hours, worst point per position',
    result: `median ${percent(p.frozenVsDirectRunUpWorstPerPosition['median'])}, p95 ${percent(p.frozenVsDirectRunUpWorstPerPosition['p95'])}, ${percent(p.runUpWithin0_5Pct, 1)} of positions within 0.5%. A larger gap means the portfolio changed in the run-up`,
  });
  rows.push({
    check: 'Frozen HF below 1 at the liquidation block (Aave requires it)',
    result: `${p.frozenHfBelow1AtLiquidation} of ${p.frozenHfBelow1AtLiquidation + p.frozenHfAtOrAbove1AtLiquidation}`,
  });
  rows.push({
    check: 'Collateral seized against the configured bonus, events over $100',
    result: `median error ${percent(p.bonusRatioError['median'])}, p95 ${percent(p.bonusRatioError['p95'])}, n=${p.bonusRatioError['n']}`,
  });
  return rows;
}

export function run(): void {
  const positions = readPositions();
  const markets = readJson<MarketSnapshot[]>(join(DERIVED_DIR, 'markets.json'));
  const thresholds = new Map<string, number>();
  for (const market of markets) {
    const usdc = market.reserves.find((r) => r.asset === CHAINS[market.chain as ChainKey].usdc.toLowerCase());
    if (usdc) thresholds.set(`${market.chain}:${market.window}`, usdc.liquidationThreshold / 1e4);
  }
  const usdcThreshold = (position: DerivedPosition): number => {
    const threshold = thresholds.get(`${position.chain}:${position.window}`);
    if (threshold === undefined) throw new Error(`no USDC threshold for ${position.id}`);
    return threshold;
  };

  const crossCheckFile = join(DERIVED_DIR, 'crosscheck.json');
  const validation = validationRows(
    readJson<ValidationFile>(VALIDATION_FILE),
    readJson<ProvenanceRow[]>(join(DERIVED_DIR, 'liquidations.provenance.json')),
    existsSync(crossCheckFile) ? readJson(crossCheckFile) : null,
  );
  const summary = buildSummary(positions, readPrices(), usdcThreshold, validation);
  writeJson(join(RESULTS_DIR, 'summary.json'), summary);
  writeFileSync(join(RESULTS_DIR, 'summary.md'), renderSummary(summary));
  const { cell } = summary.headline;
  console.log(`positions in scope ${cell.positions}, excluded ${summary.excludedPositions}`);
  console.log(`headline: saved ${cell.saved}, not saved ${cell.notSaved}, bonus avoided $${cell.bonusAvoidedUsd}`);
  console.log(`wrote ${join(RESULTS_DIR, 'summary.json')} and summary.md`);
  runHyperliquid();
}

if (import.meta.url === `file://${process.argv[1]}`) run();
