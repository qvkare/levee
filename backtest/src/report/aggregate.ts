// Turns per-position outcomes into the published numbers. No I/O.
import { CHAINS, type ChainKey } from '../config.ts';
import { decodeObserved, type CompactPoint, type DerivedPosition } from '../data.ts';
import { COOLDOWN_SEC, COOLDOWN_SENSITIVITY_SEC, GRID } from '../grid.ts';
import { holdAsCollateral, repayAtArming, reserveNeeded } from '../sim/baselines.ts';
import { healthFactor, simulate, type Outcome, type Params, type PositionPath, type Reason } from '../sim/simulate.ts';

/** The cell the headline quotes. The grid shows the rest. */
export const HEADLINE = { trigger: 1.2, target: 1.5, reserveShare: 0.3, delaySec: 60 } as const;

/** Later liquidations this long after the previous one count as a separate episode. */
const EPISODE_GAP_SEC = 3600;

export interface Prepared {
  position: DerivedPosition;
  path: PositionPath;
  /** Bonus on the first episode only. A later episode may be a position rebuilt by its owner. */
  firstEpisodeBonusUsd: number;
  allBonusUsd: number;
  usdcThreshold: number;
}

export function firstEpisodeBonus(position: DerivedPosition): number {
  const events = [...position.events].sort((a, b) => a.t - b.t);
  let total = 0;
  let previous = events[0]?.t ?? 0;
  for (const event of events) {
    if (event.t - previous > EPISODE_GAP_SEC) break;
    total += event.bonusUsd;
    previous = event.t;
  }
  return total;
}

/** `frozen` starts at the liquidation block. See `PriceBook.frozenPath`. */
export function prepare(position: DerivedPosition, usdcThreshold: number, frozen: CompactPoint[]): Prepared {
  if (!position.observed) throw new Error(`${position.id} has no path`);
  return {
    position,
    path: {
      points: [...decodeObserved(position.observed), ...frozen].map(([block, t, capacity, debt]) => ({ block, t, capacity, debt })),
      liquidationBlock: position.liquidationBlock,
      liquidationTime: position.liquidationTime,
      usdcShare: position.usdcShare,
    },
    firstEpisodeBonusUsd: firstEpisodeBonus(position),
    allBonusUsd: position.events.reduce((sum, e) => sum + e.bonusUsd, 0),
    usdcThreshold,
  };
}

export interface Cell {
  trigger: number;
  target: number;
  reserveShare: number;
  delaySec: number;
  positions: number;
  saved: number;
  notSaved: number;
  /** HF was already below the trigger when armed, so the repay fires at once. */
  armedBelowTrigger: number;
  /** Of those, saved. That is an upfront repay, not a rescue. */
  savedArmedBelowTrigger: number;
  reasons: Record<Reason, number>;
  /** Among misses, those that beat the real liquidation and failed later in the window. */
  failedLaterInWindow: number;
  bonusAvoidedUsd: number;
  /** The part of `bonusAvoidedUsd` on positions armed above T, where a race happened. */
  bonusAvoidedArmedAboveUsd: number;
  bonusAtRiskUsd: number;
  reserveHeldUsd: number;
  reserveUsedOnSavedUsd: number;
  reserveUsedOnMissesUsd: number;
}

const emptyReasons = (): Record<Reason, number> => ({
  saved: 0,
  no_warning: 0,
  too_slow: 0,
  reserve_empty: 0,
  usdc_debt_exhausted: 0,
  follow_up_too_slow: 0,
});

export function aggregate(rows: Array<{ item: Prepared; outcome: Outcome }>, params: Params): Cell {
  const cell: Cell = {
    trigger: params.trigger,
    target: params.target,
    reserveShare: params.reserveShare,
    delaySec: params.delaySec,
    positions: rows.length,
    saved: 0,
    notSaved: 0,
    armedBelowTrigger: 0,
    savedArmedBelowTrigger: 0,
    reasons: emptyReasons(),
    failedLaterInWindow: 0,
    bonusAvoidedUsd: 0,
    bonusAvoidedArmedAboveUsd: 0,
    bonusAtRiskUsd: 0,
    reserveHeldUsd: 0,
    reserveUsedOnSavedUsd: 0,
    reserveUsedOnMissesUsd: 0,
  };
  for (const { item, outcome } of rows) {
    cell.bonusAtRiskUsd += item.firstEpisodeBonusUsd;
    cell.reserveHeldUsd += outcome.reserve;
    cell.reasons[outcome.reason]++;
    if (outcome.armedBelowTrigger) cell.armedBelowTrigger++;
    if (outcome.saved) {
      cell.saved++;
      cell.bonusAvoidedUsd += item.firstEpisodeBonusUsd;
      cell.reserveUsedOnSavedUsd += outcome.repaid;
      if (outcome.armedBelowTrigger) cell.savedArmedBelowTrigger++;
      else cell.bonusAvoidedArmedAboveUsd += item.firstEpisodeBonusUsd;
    } else {
      cell.notSaved++;
      cell.reserveUsedOnMissesUsd += outcome.repaid;
      if (outcome.phase === 'later_in_window') cell.failedLaterInWindow++;
    }
  }
  return roundCell(cell);
}

function roundCell(cell: Cell): Cell {
  for (const key of ['bonusAvoidedUsd', 'bonusAvoidedArmedAboveUsd', 'bonusAtRiskUsd', 'reserveHeldUsd', 'reserveUsedOnSavedUsd', 'reserveUsedOnMissesUsd'] as const) {
    cell[key] = Math.round(cell[key]);
  }
  return cell;
}

export const paramsOf = (cell: Pick<Params, 'trigger' | 'target' | 'reserveShare' | 'delaySec'>): Params => ({
  trigger: cell.trigger,
  target: cell.target,
  reserveShare: cell.reserveShare,
  delaySec: cell.delaySec,
  cooldownSec: COOLDOWN_SEC,
});

export function runGrid(items: Prepared[]): Cell[] {
  const cells: Cell[] = [];
  for (const target of GRID.targets) {
    for (const trigger of GRID.triggers) {
      if (trigger >= target) continue;
      for (const reserveShare of GRID.reserveShares) {
        for (const delaySec of GRID.delaysSec) {
          const params = paramsOf({ trigger, target, reserveShare, delaySec });
          cells.push(aggregate(items.map((item) => ({ item, outcome: simulate(item.path, params) })), params));
        }
      }
    }
  }
  return cells;
}

/** Time from the start of the final descent through T to the first liquidation. */
export function finalDescentGap(path: PositionPath, trigger: number): number | 'never_below' | 'below_since_arming' {
  const observed = path.points.filter((p) => p.block < path.liquidationBlock && p.debt > 0);
  let lastAbove = -1;
  for (let i = observed.length - 1; i >= 0; i--) {
    const point = observed[i]!;
    if (healthFactor(point.capacity, point.debt) >= trigger) {
      lastAbove = i;
      break;
    }
  }
  if (lastAbove === observed.length - 1) return 'never_below';
  if (lastAbove === -1) return 'below_since_arming';
  return path.liquidationTime - observed[lastAbove + 1]!.t;
}

export interface WarningRow {
  trigger: number;
  positions: number;
  /** Positions with a final descent through T, which the gap statistics describe. */
  withDescent: number;
  neverBelowBeforeLiquidation: number;
  belowSinceArming: number;
  medianGapSec: number | null;
  atLeast: Record<string, number>;
}

export function warningTable(items: Prepared[]): WarningRow[] {
  const limits = [10, 30, 60, 120, 300, 900, 3600];
  return GRID.triggers.map((trigger) => {
    const gaps: number[] = [];
    let never = 0;
    let since = 0;
    for (const item of items) {
      const gap = finalDescentGap(item.path, trigger);
      if (gap === 'never_below') never++;
      else if (gap === 'below_since_arming') since++;
      else gaps.push(gap);
    }
    gaps.sort((a, b) => a - b);
    return {
      trigger,
      positions: items.length,
      withDescent: gaps.length,
      neverBelowBeforeLiquidation: never,
      belowSinceArming: since,
      medianGapSec: gaps.length ? gaps[Math.floor(gaps.length / 2)]! : null,
      atLeast: Object.fromEntries(limits.map((limit) => [String(limit), gaps.filter((g) => g >= limit).length])),
    };
  });
}

export interface FairRow {
  reserveShare: number;
  positions: number;
  levee: number;
  holdAsCollateral: number;
  repayAtArming: number;
  both: number;
  leveeOnly: number;
  collateralOnly: number;
  neither: number;
  bonusAvoidedLeveeUsd: number;
  bonusAvoidedCollateralUsd: number;
  bonusAvoidedRepayAtArmingUsd: number;
}

function fairRow(items: Prepared[], params: Params): FairRow {
  const { reserveShare } = params;
  const row: FairRow = {
    reserveShare,
    positions: items.length,
    levee: 0,
    holdAsCollateral: 0,
    repayAtArming: 0,
    both: 0,
    leveeOnly: 0,
    collateralOnly: 0,
    neither: 0,
    bonusAvoidedLeveeUsd: 0,
    bonusAvoidedCollateralUsd: 0,
    bonusAvoidedRepayAtArmingUsd: 0,
  };
  for (const item of items) {
    const levee = simulate(item.path, params).saved;
    const collateral = holdAsCollateral(item.path, reserveShare, item.usdcThreshold).survived;
    const bonus = item.firstEpisodeBonusUsd;
    if (repayAtArming(item.path, reserveShare).survived) {
      row.repayAtArming++;
      row.bonusAvoidedRepayAtArmingUsd += bonus;
    }
    if (levee) {
      row.levee++;
      row.bonusAvoidedLeveeUsd += bonus;
    }
    if (collateral) {
      row.holdAsCollateral++;
      row.bonusAvoidedCollateralUsd += bonus;
    }
    if (levee && collateral) row.both++;
    else if (levee) row.leveeOnly++;
    else if (collateral) row.collateralOnly++;
    else row.neither++;
  }
  row.bonusAvoidedLeveeUsd = Math.round(row.bonusAvoidedLeveeUsd);
  row.bonusAvoidedCollateralUsd = Math.round(row.bonusAvoidedCollateralUsd);
  row.bonusAvoidedRepayAtArmingUsd = Math.round(row.bonusAvoidedRepayAtArmingUsd);
  return row;
}

export function fairComparison(items: Prepared[], base: { trigger: number; target: number; delaySec: number }): FairRow[] {
  return GRID.reserveShares.map((reserveShare) => fairRow(items, paramsOf({ ...base, reserveShare })));
}

export interface DelayRow extends FairRow {
  delaySec: number;
}

/** The same comparison at one reserve size, across delays. */
export function fairByDelay(items: Prepared[], base: { trigger: number; target: number; reserveShare: number }): DelayRow[] {
  return GRID.delaysSec.map((delaySec) => ({ delaySec, ...fairRow(items, paramsOf({ ...base, delaySec })) }));
}

export interface NeededRow {
  group: string;
  positions: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  /** Share of positions a reserve of this size would not cover, even repaid at once. */
  above30Pct: number;
  above50Pct: number;
}

function neededRow(group: string, list: Prepared[]): NeededRow {
  const needed = list.map((item) => reserveNeeded(item.path)).sort((a, b) => a - b);
  const at = (q: number): number => needed[Math.min(needed.length - 1, Math.floor(q * needed.length))]!;
  const above = (limit: number): number => needed.filter((n) => n > limit).length / needed.length;
  return { group, positions: list.length, p25: at(0.25), p50: at(0.5), p75: at(0.75), p90: at(0.9), above30Pct: above(0.3), above50Pct: above(0.5) };
}

export function reserveNeededTable(items: Prepared[], labelOf: (item: Prepared) => string): NeededRow[] {
  const groups = new Map<string, Prepared[]>();
  for (const item of items) groups.set(labelOf(item), [...(groups.get(labelOf(item)) ?? []), item]);
  const rows = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([group, list]) => neededRow(group, list));
  return [...rows, neededRow('All', items)];
}

export interface DelayGroupRow {
  group: string;
  positions: number;
  armedAbove: number;
  /** Saved among positions armed above T, by delay. */
  savedArmedAbove: Record<string, number>;
  /** Liquidator won the race, by delay. */
  tooSlow: Record<string, number>;
}

/** Delay shown per group, among positions armed above T, where a race actually happens. */
export function delayByGroup(items: Prepared[], base: { trigger: number; target: number; reserveShare: number }, labelOf: (item: Prepared) => string): DelayGroupRow[] {
  const groups = new Map<string, Prepared[]>();
  for (const item of items) groups.set(labelOf(item), [...(groups.get(labelOf(item)) ?? []), item]);
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, list]) => {
      const row: DelayGroupRow = { group, positions: list.length, armedAbove: 0, savedArmedAbove: {}, tooSlow: {} };
      for (const delaySec of GRID.delaysSec) {
        const outcomes = list.map((item) => simulate(item.path, paramsOf({ ...base, delaySec })));
        const above = outcomes.filter((o) => !o.armedBelowTrigger);
        row.armedAbove = above.length;
        row.savedArmedAbove[String(delaySec)] = above.filter((o) => o.saved).length;
        row.tooSlow[String(delaySec)] = above.filter((o) => o.reason === 'too_slow' || o.reason === 'no_warning').length;
      }
      return row;
    });
}

export interface CooldownRow {
  cooldownSec: number;
  saved: number;
  followUpTooSlow: number;
}

export function cooldownSensitivity(items: Prepared[], params: Params): CooldownRow[] {
  return COOLDOWN_SENSITIVITY_SEC.map((cooldownSec) => {
    const outcomes = items.map((item) => simulate(item.path, { ...params, cooldownSec }));
    return {
      cooldownSec,
      saved: outcomes.filter((o) => o.saved).length,
      followUpTooSlow: outcomes.filter((o) => o.reason === 'follow_up_too_slow').length,
    };
  });
}

export const SIZE_BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: 'under $100', min: 0, max: 100 },
  { label: '$100 to $1k', min: 100, max: 1_000 },
  { label: '$1k to $10k', min: 1_000, max: 10_000 },
  { label: '$10k to $100k', min: 10_000, max: 100_000 },
  { label: '$100k and up', min: 100_000, max: Infinity },
];

export interface GroupRow extends Cell {
  group: string;
}

/** The headline cell split by a label. */
export function byGroup(items: Prepared[], params: Params, labelOf: (item: Prepared) => string): GroupRow[] {
  const groups = new Map<string, Prepared[]>();
  for (const item of items) {
    const label = labelOf(item);
    groups.set(label, [...(groups.get(label) ?? []), item]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, list]) => ({ group, ...aggregate(list.map((item) => ({ item, outcome: simulate(item.path, params) })), params) }));
}

export interface Exclusion {
  reason: string;
  positions: number;
  liquidatedDebtUsd: number;
}

export function exclusions(positions: DerivedPosition[]): Exclusion[] {
  const rows = new Map<string, Exclusion>();
  const bridged: Partial<Record<ChainKey, Record<string, string>>> = {
    arbitrum: { '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': 'USDC.e (bridged, not repayable with native USDC)' },
    base: { '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': 'USDbC (bridged, not repayable with native USDC)' },
  };
  for (const position of positions) {
    if (position.scope !== 'no_usdc_debt') continue;
    const reason = bridged[position.chain]?.[position.largestDebt.asset] ?? `${position.largestDebt.symbol} debt`;
    const row = rows.get(reason) ?? { reason, positions: 0, liquidatedDebtUsd: 0 };
    row.positions++;
    row.liquidatedDebtUsd += position.events.reduce((sum, e) => sum + e.debtUsd, 0);
    rows.set(reason, row);
  }
  return [...rows.values()].map((r) => ({ ...r, liquidatedDebtUsd: Math.round(r.liquidatedDebtUsd) })).sort((a, b) => b.positions - a.positions);
}

export interface Population {
  chain: ChainKey;
  window: string;
  events: number;
  positions: number;
  inScope: number;
  usdcOnly: number;
  usdcMixed: number;
  excluded: number;
  liquidatedDebtUsd: number;
  grossBonusUsd: number;
}

export function population(positions: DerivedPosition[]): Population[] {
  const rows = new Map<string, Population>();
  for (const position of positions) {
    const key = `${position.chain}:${position.window}`;
    const row =
      rows.get(key) ??
      ({ chain: position.chain, window: position.window, events: 0, positions: 0, inScope: 0, usdcOnly: 0, usdcMixed: 0, excluded: 0, liquidatedDebtUsd: 0, grossBonusUsd: 0 } satisfies Population);
    row.events += position.events.length;
    row.positions++;
    if (position.scope === 'usdc_only') row.usdcOnly++;
    if (position.scope === 'usdc_mixed') row.usdcMixed++;
    if (position.scope === 'no_usdc_debt') row.excluded++;
    else row.inScope++;
    row.liquidatedDebtUsd += position.events.reduce((sum, e) => sum + e.debtUsd, 0);
    row.grossBonusUsd += position.events.reduce((sum, e) => sum + e.bonusUsd, 0);
    rows.set(key, row);
  }
  return [...rows.values()]
    .map((r) => ({ ...r, liquidatedDebtUsd: Math.round(r.liquidatedDebtUsd), grossBonusUsd: Math.round(r.grossBonusUsd) }))
    .sort((a, b) => a.window.localeCompare(b.window) || a.chain.localeCompare(b.chain));
}

export { CHAINS };
