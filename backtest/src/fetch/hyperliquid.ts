// Optional, separate from Aave. Downloads one CSV at a pinned commit, checks its hash, and
// reduces it to the BTC and ETH cross-margin longs. Nothing from the file is executed.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { DERIVED_DIR, existsSync, RAW_DIR } from '../paths.ts';

export const HL_SOURCE = {
  repository: 'ConejoCapital/HyperMultiAssetedADL',
  commit: '79bad0fae259fc1fcd9fce960953ae3b398f2db7',
  path: 'data/canonical/cash-only balances ADL event orderbook 2025-10-10/liquidations_full_12min.csv',
  sha256: '1afd4c09494665d82fadf3ad65fb210b6b3a2213ab66ed2bc179aa23b2b55684',
} as const;

export interface HlPosition {
  coin: 'BTC' | 'ETH';
  user: string;
  firstFill: string;
  /** Coins liquidated across all fills. */
  size: number;
  /** Size-weighted fill price. */
  fillPrice: number;
  /** Fill price less closed PnL per coin. */
  entryPrice: number;
}

export interface HlData {
  source: typeof HL_SOURCE;
  rows: number;
  /** Lowest and highest fill price of any BTC or ETH cross long, liquidator rows included. */
  prices: Record<'BTC' | 'ETH', { high: number; low: number; firstFill: string; lastFill: string }>;
  excludedLiquidators: string[];
  positions: HlPosition[];
}

export const HL_FILE = join(DERIVED_DIR, 'hyperliquid.json.gz');
const RAW_CSV = join(RAW_DIR, 'hyperliquid', 'liquidations_full_12min.csv');

const round = (x: number, digits: number): number => Number(x.toFixed(digits));

export function reduceCsv(text: string): HlData {
  const [header, ...lines] = text.trim().split('\n');
  const columns = header!.split(',');
  const at = (name: string): number => {
    const index = columns.indexOf(name);
    if (index < 0) throw new Error(`no column ${name}`);
    return index;
  };
  const [time, user, coin, direction, price, size, side, pnl] = ['block_time', 'user', 'coin', 'direction', 'price', 'size', 'side', 'closed_pnl'].map(at) as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const rows = lines.map((line) => line.split(','));

  // On a long liquidation the borrower sells, so whoever buys (side B) took the other side.
  const liquidators = new Set(rows.filter((r) => r[direction]!.includes('Long') && r[side] === 'B').map((r) => r[user]!));

  const prices = {} as HlData['prices'];
  for (const name of ['BTC', 'ETH'] as const) {
    const fills = rows.filter((r) => r[coin] === name && r[direction] === 'Liquidated Cross Long');
    const values = fills.map((r) => Number(r[price]));
    const times = fills.map((r) => r[time]!).sort();
    prices[name] = { high: Math.max(...values), low: Math.min(...values), firstFill: times[0]!, lastFill: times[times.length - 1]! };
  }

  const byPosition = new Map<string, { coin: 'BTC' | 'ETH'; user: string; firstFill: string; size: number; cost: number; pnl: number }>();
  for (const r of rows) {
    const name = r[coin];
    if ((name !== 'BTC' && name !== 'ETH') || r[direction] !== 'Liquidated Cross Long' || r[side] !== 'A' || liquidators.has(r[user]!)) continue;
    const key = `${name}:${r[user]}`;
    const position = byPosition.get(key) ?? { coin: name, user: r[user]!, firstFill: r[time]!, size: 0, cost: 0, pnl: 0 };
    position.size += Number(r[size]);
    position.cost += Number(r[size]) * Number(r[price]);
    position.pnl += Number(r[pnl]);
    if (r[time]! < position.firstFill) position.firstFill = r[time]!;
    byPosition.set(key, position);
  }
  const positions = [...byPosition.values()]
    .map((p) => {
      const fillPrice = p.cost / p.size;
      return { coin: p.coin, user: p.user, firstFill: p.firstFill, size: round(p.size, 6), fillPrice: round(fillPrice, 4), entryPrice: round(fillPrice - p.pnl / p.size, 4) };
    })
    .sort((a, b) => a.coin.localeCompare(b.coin) || a.user.localeCompare(b.user));
  return { source: HL_SOURCE, rows: rows.length, prices, excludedLiquidators: [...liquidators].sort(), positions };
}

export async function fetchHyperliquid(): Promise<void> {
  if (!existsSync(RAW_CSV)) {
    const url = `https://raw.githubusercontent.com/${HL_SOURCE.repository}/${HL_SOURCE.commit}/${HL_SOURCE.path.split('/').map(encodeURIComponent).join('/')}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    mkdirSync(join(RAW_DIR, 'hyperliquid'), { recursive: true });
    writeFileSync(RAW_CSV, Buffer.from(await response.arrayBuffer()));
  }
  const bytes = readFileSync(RAW_CSV);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== HL_SOURCE.sha256) throw new Error(`hash mismatch: ${digest}`);
  const data = reduceCsv(bytes.toString('utf8'));
  writeFileSync(HL_FILE, gzipSync(JSON.stringify(data), { level: 9 }));
  console.log(`${data.rows} rows, ${data.positions.length} positions, liquidators excluded: ${data.excludedLiquidators.length}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await fetchHyperliquid();
