// Builds the object written to results/summary.json.
import type { DerivedPosition, WindowPrices } from '../data.ts';
import { PriceBook } from '../frozen.ts';
import { healthFactor, simulate } from '../sim/simulate.ts';
import {
  byGroup,
  exclusions,
  fairByDelay,
  fairComparison,
  HEADLINE,
  paramsOf,
  population,
  prepare,
  runGrid,
  SIZE_BUCKETS,
  warningTable,
  type Cell,
  type DelayRow,
  type Exclusion,
  type FairRow,
  type GroupRow,
  type Population,
  type Prepared,
  type WarningRow,
} from './aggregate.ts';

export interface Example {
  label: string;
  chain: string;
  user: string;
  debtUsd: number;
  hfAtArming: number;
  firstBelowTrigger: string | null;
  liquidation: string;
  reason: string;
  tx: string;
}

export interface ValidationRow {
  check: string;
  result: string;
}

export interface Summary {
  headlineParams: typeof HEADLINE;
  headline: { cell: Cell; fair: FairRow };
  population: Population[];
  exclusions: Exclusion[];
  excludedPositions: number;
  warning: WarningRow[];
  grid: Cell[];
  fair: FairRow[];
  fairByDelay: DelayRow[];
  fairNote: string;
  byWindow: GroupRow[];
  byChain: GroupRow[];
  byDebtScope: GroupRow[];
  bySize: GroupRow[];
  examples: Example[];
  validation: ValidationRow[];
}

const iso = (t: number): string => new Date(t * 1000).toISOString().replace('.000Z', 'Z');

function example(label: string, item: Prepared): Example {
  const outcome = simulate(item.path, paramsOf(HEADLINE));
  const first = item.path.points.find((p) => p.debt > 0)!;
  return {
    label,
    chain: item.position.chain,
    user: item.position.user,
    debtUsd: item.position.debtUsd,
    hfAtArming: healthFactor(first.capacity, first.debt),
    firstBelowTrigger: outcome.firstDetection === null ? null : iso(outcome.firstDetection),
    liquidation: iso(item.position.liquidationTime),
    reason: outcome.reason,
    tx: item.position.events[0]!.tx,
  };
}

function pickExamples(items: Prepared[]): Example[] {
  const params = paramsOf(HEADLINE);
  const byDebt = [...items].sort((a, b) => b.position.debtUsd - a.position.debtUsd || a.position.id.localeCompare(b.position.id));
  const wanted: Array<[string, (reason: string) => boolean]> = [
    ['Largest saved', (r) => r === 'saved'],
    ['Largest too_slow', (r) => r === 'too_slow'],
    ['Largest reserve_empty', (r) => r === 'reserve_empty'],
    ['Largest no_warning', (r) => r === 'no_warning'],
  ];
  const out: Example[] = [];
  for (const [label, test] of wanted) {
    const hit = byDebt.find((item) => test(simulate(item.path, params).reason));
    if (hit) out.push(example(label, hit));
  }
  return out;
}

export function buildSummary(positions: DerivedPosition[], prices: WindowPrices[], usdcThreshold: (p: DerivedPosition) => number, validation: ValidationRow[]): Summary {
  const books = new Map(prices.map((p) => [`${p.chain}:${p.window}`, new PriceBook(p)]));
  const items = positions
    .filter((p) => p.scope !== 'no_usdc_debt')
    .map((p) => prepare(p, usdcThreshold(p), books.get(`${p.chain}:${p.window}`)!.frozenPath(p.portfolio!, p.liquidationBlock, p.liquidationTime)));
  const grid = runGrid(items);
  const fair = fairComparison(items, HEADLINE);
  const params = paramsOf(HEADLINE);
  const cell = grid.find(
    (c) => c.trigger === HEADLINE.trigger && c.target === HEADLINE.target && c.reserveShare === HEADLINE.reserveShare && c.delaySec === HEADLINE.delaySec,
  )!;
  const fairRow = fair.find((r) => r.reserveShare === HEADLINE.reserveShare)!;
  const threshold = items[0]?.usdcThreshold ?? 0.78;
  return {
    headlineParams: HEADLINE,
    headline: { cell, fair: fairRow },
    population: population(positions),
    exclusions: exclusions(positions),
    excludedPositions: positions.length - items.length,
    warning: warningTable(items),
    grid,
    fair,
    fairByDelay: fairByDelay(items, HEADLINE),
    fairNote:
      `A dollar repaid offsets a dollar of debt. A dollar of USDC collateral adds only its liquidation threshold (${threshold.toFixed(2)}) of capacity, so a repay that lands is worth ${(1 / threshold).toFixed(2)} times as much at the point of liquidation. ` +
      'That is the only survival edge Levee has over plain collateral, and it exists only if the repay lands first. ' +
      '"Both survive" and "Neither" are where Levee adds no survival benefit. "Collateral only" is where Levee does worse because its repay was late. ' +
      'The upside of keeping the reserve off the venue, such as yield or sharing it across positions, is not measured here.',
    byWindow: byGroup(items, params, (item) => item.position.window),
    byChain: byGroup(items, params, (item) => item.position.chain),
    byDebtScope: byGroup(items, params, (item) => (item.position.scope === 'usdc_only' ? 'USDC only' : 'Mixed debt')),
    bySize: byGroup(items, params, (item) => {
      const index = SIZE_BUCKETS.findIndex((b) => item.position.debtUsd >= b.min && item.position.debtUsd < b.max);
      return `${index + 1}. ${SIZE_BUCKETS[index]!.label}`;
    }),
    examples: pickExamples(items),
    validation,
  };
}
