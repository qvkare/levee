// Hyperliquid survival tables for 2025-10-10. Reference only, and kept apart from the Aave
// results: this is another venue, another data set and a much weaker method.
//
// The source file holds liquidation fills only. It has no survivors, no account margin and
// no mark prices, so what it supports is limited and the output says so.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { HL_FILE, type HlData, type HlPosition } from './fetch/hyperliquid.ts';
import { RESULTS_DIR, writeJson } from './paths.ts';

export const MAINTENANCE: Record<'BTC' | 'ETH', number> = {
  // Half the initial margin at max leverage. Hyperliquid docs, margin tiers: 40x and 25x.
  BTC: 1 / 80,
  ETH: 1 / 50,
};

export const LEVERAGES = [3, 5, 10] as const;
export const TOP_UPS = [0.25, 0.5, 1, 2] as const;

/** Price fall from entry that takes a lone long at leverage L down to maintenance margin. */
export function liquidationDistance(leverage: number, maintenance: number): number {
  return (1 / leverage - maintenance) / (1 - maintenance);
}

/** Top-up, in units of starting equity, that keeps a lone long at maintenance after `drop`. */
export function topUpNeeded(leverage: number, maintenance: number, drop: number): number {
  return Math.max(0, leverage * (drop + maintenance * (1 - drop)) - 1);
}

/** The leverage a lone long would have needed to be liquidated this far from its entry. */
export function inferredLeverage(position: Pick<HlPosition, 'entryPrice' | 'fillPrice'>, maintenance: number): number | null {
  const drop = 1 - position.fillPrice / position.entryPrice;
  const denominator = drop + maintenance * (1 - drop);
  return denominator > 0 && drop > 0 ? 1 / denominator : null;
}

export function bucketOf(leverage: number): '3x' | '5x' | '10x' | 'over 15x' {
  if (leverage <= 3.5) return '3x';
  if (leverage <= 7) return '5x';
  if (leverage <= 15) return '10x';
  return 'over 15x';
}

export interface FreshRow {
  coin: 'BTC' | 'ETH';
  leverage: number;
  liquidationDistance: number;
  dropInFile: number;
  survivesUnprotected: boolean;
  topUpNeededE: number;
}

export interface LiquidatedRow {
  coin: 'BTC' | 'ETH';
  bucket: string;
  positions: number;
  notionalUsd: number;
  survivedWithTopUp: Record<string, number>;
}

export interface HlSummary {
  source: HlData['source'];
  rows: number;
  positionsUsed: number;
  positionsWithoutLoss: number;
  prices: HlData['prices'];
  fresh: FreshRow[];
  liquidated: LiquidatedRow[];
}

export function summarizeHyperliquid(data: HlData): HlSummary {
  const fresh: FreshRow[] = [];
  const liquidated: LiquidatedRow[] = [];
  let withoutLoss = 0;
  for (const coin of ['BTC', 'ETH'] as const) {
    const maintenance = MAINTENANCE[coin];
    const { high, low } = data.prices[coin];
    const drop = 1 - low / high;
    for (const leverage of LEVERAGES) {
      const distance = liquidationDistance(leverage, maintenance);
      fresh.push({
        coin,
        leverage,
        liquidationDistance: distance,
        dropInFile: drop,
        survivesUnprotected: drop < distance,
        topUpNeededE: topUpNeeded(leverage, maintenance, drop),
      });
    }
    const rows = new Map<string, LiquidatedRow>();
    for (const bucket of ['3x', '5x', '10x', 'over 15x']) {
      rows.set(bucket, { coin, bucket, positions: 0, notionalUsd: 0, survivedWithTopUp: Object.fromEntries(TOP_UPS.map((t) => [String(t), 0])) });
    }
    for (const position of data.positions) {
      if (position.coin !== coin) continue;
      const leverage = inferredLeverage(position, maintenance);
      if (leverage === null) {
        withoutLoss++;
        continue;
      }
      const row = rows.get(bucketOf(leverage))!;
      row.positions++;
      row.notionalUsd += position.size * position.fillPrice;
      const dropToLow = 1 - low / position.entryPrice;
      for (const topUp of TOP_UPS) {
        if (topUpNeeded(leverage, maintenance, dropToLow) <= topUp) row.survivedWithTopUp[String(topUp)]!++;
      }
    }
    liquidated.push(...[...rows.values()].map((r) => ({ ...r, notionalUsd: Math.round(r.notionalUsd) })));
  }
  return { source: data.source, rows: data.rows, positionsUsed: data.positions.length - withoutLoss, positionsWithoutLoss: withoutLoss, prices: data.prices, fresh, liquidated };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const usd = (x: number): string => (x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : `$${(x / 1e3).toFixed(0)}k`);

export function renderHyperliquid(s: HlSummary): string {
  const lines: string[] = [];
  lines.push('# Hyperliquid reference: 2025-10-10');
  lines.push('');
  lines.push('**This is not part of the Aave result and says nothing about a Levee rescue.** Hyperliquid is a separate gate in `docs/SPEC.md` section 1. No delay is modelled here.');
  lines.push('');
  lines.push(`Source: \`${s.source.repository}\` at commit \`${s.source.commit}\`, \`liquidations_full_12min.csv\`, sha256 \`${s.source.sha256}\`. ${s.rows} rows. ${s.positionsUsed} liquidated cross-margin BTC and ETH longs used, ${s.positionsWithoutLoss} left out because their fills show no loss against entry.`);
  lines.push('');
  lines.push('## What the file cannot show');
  lines.push('');
  lines.push('- **No survivors.** It lists liquidations only, so a true survival rate at any leverage cannot be computed from it.');
  lines.push('- **No account margin.** Leverage below is inferred from entry and fill, as if the position were alone in the account. Cross accounts often are not.');
  lines.push('- **No marks.** Liquidation uses the mark price. The file has fills, which can print below it. An earlier note puts the 1-day BTC low on Hyperliquid at 100,837, above the lowest fill here.');
  lines.push('- **Twelve minutes only.** The first BTC or ETH cross fill is after the fall had begun, so the drop below understates the full move.');
  lines.push('- **No timing.** With no mark path there is no way to place a trigger in time, so a top-up is assumed to arrive. ADL is out of scope.');
  lines.push('');
  lines.push('## Fresh long opened at the highest fill in the file');
  lines.push('');
  lines.push('A lone cross long entered at the highest fill price and marked to the lowest. This is arithmetic on a proxy, not an observed position.');
  lines.push('');
  lines.push('| Coin | Leverage | Fall to liquidation | Fall in file | Survives with no top-up | Top-up needed |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of s.fresh) {
    lines.push(`| ${r.coin} | ${r.leverage}x | ${pct(r.liquidationDistance)} | ${pct(r.dropInFile)} | ${r.survivesUnprotected ? 'yes' : 'no'} | ${r.topUpNeededE === 0 ? 'none' : `${r.topUpNeededE.toFixed(2)} E`} |`);
  }
  lines.push('');
  lines.push('E is starting equity.');
  lines.push('');
  lines.push('## Positions that were liquidated, by inferred leverage');
  lines.push('');
  lines.push('Conditional on liquidation, so 0% survived with no top-up by construction. Each column is the share that would have stayed above maintenance at the lowest fill in the file if that top-up had arrived in time. Buckets: 3x is up to 3.5x, 5x is 3.5x to 7x, 10x is 7x to 15x.');
  lines.push('');
  lines.push(`| Coin | Inferred leverage | Positions | Notional | ${TOP_UPS.map((t) => `${t} E`).join(' | ')} |`);
  lines.push(`|---|---|---|---|${TOP_UPS.map(() => '---').join('|')}|`);
  for (const r of s.liquidated) {
    const cells = TOP_UPS.map((t) => (r.positions ? pct((r.survivedWithTopUp[String(t)] ?? 0) / r.positions) : 'n/a'));
    lines.push(`| ${r.coin} | ${r.bucket} | ${r.positions} | ${usd(r.notionalUsd)} | ${cells.join(' | ')} |`);
  }
  lines.push('');
  lines.push('Many liquidated positions show low inferred leverage because they were entered far above the crash price, not because they started safe. A long opened near the top is not the same as a fresh long at that leverage.');
  lines.push('');
  return lines.join('\n');
}

export function runHyperliquid(): void {
  const data = JSON.parse(gunzipSync(readFileSync(HL_FILE)).toString('utf8')) as HlData;
  const summary = summarizeHyperliquid(data);
  writeJson(join(RESULTS_DIR, 'hyperliquid.json'), summary);
  writeFileSync(join(RESULTS_DIR, 'hyperliquid.md'), renderHyperliquid(summary));
  console.log(`hyperliquid: ${summary.positionsUsed} positions, wrote hyperliquid.json and hyperliquid.md`);
}
