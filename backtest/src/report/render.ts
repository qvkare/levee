// Markdown for results/summary.md. Wording follows docs/SPEC.md section 8.
import { WINDOWS } from '../config.ts';
import { GRID } from '../grid.ts';
import { HEADLINE, SIZE_BUCKETS, type Cell, type Exclusion, type FairRow, type GroupRow, type Population, type WarningRow } from './aggregate.ts';
import type { Example, Summary } from './summary.ts';

const usd = (x: number): string => {
  const abs = Math.abs(x);
  if (abs >= 1e6) return `$${(x / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(x / 1e3).toFixed(1)}k`;
  return `$${x.toFixed(0)}`;
};
const pct = (part: number, whole: number): string => (whole === 0 ? 'n/a' : `${((part / whole) * 100).toFixed(1)}%`);
const share = (x: number): string => `${(x * 100).toFixed(0)}%`;
const duration = (sec: number | null): string => {
  if (sec === null) return 'n/a';
  if (sec < 120) return `${sec} s`;
  if (sec < 7200) return `${(sec / 60).toFixed(0)} min`;
  return `${(sec / 3600).toFixed(1)} h`;
};

function table(headers: string[], rows: Array<Array<string | number>>): string {
  const lines = [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`];
  for (const row of rows) lines.push(`| ${row.join(' | ')} |`);
  return lines.join('\n');
}

const find = (cells: Cell[], trigger: number, target: number, reserveShare: number, delaySec: number): Cell => {
  const cell = cells.find((c) => c.trigger === trigger && c.target === target && c.reserveShare === reserveShare && c.delaySec === delaySec);
  if (!cell) throw new Error(`no cell ${trigger} ${target} ${reserveShare} ${delaySec}`);
  return cell;
};

function populationTable(rows: Population[]): string {
  const label = (id: string): string => WINDOWS.find((w) => w.id === id)?.label ?? id;
  const total = rows.reduce(
    (sum, r) => ({
      events: sum.events + r.events,
      positions: sum.positions + r.positions,
      inScope: sum.inScope + r.inScope,
      usdcOnly: sum.usdcOnly + r.usdcOnly,
      usdcMixed: sum.usdcMixed + r.usdcMixed,
      excluded: sum.excluded + r.excluded,
      liquidatedDebtUsd: sum.liquidatedDebtUsd + r.liquidatedDebtUsd,
      grossBonusUsd: sum.grossBonusUsd + r.grossBonusUsd,
    }),
    { events: 0, positions: 0, inScope: 0, usdcOnly: 0, usdcMixed: 0, excluded: 0, liquidatedDebtUsd: 0, grossBonusUsd: 0 },
  );
  return table(
    ['Window', 'Chain', 'LiquidationCall events', 'Positions', 'In scope', 'USDC only', 'Mixed debt', 'Excluded', 'Debt liquidated', 'Gross bonus paid'],
    [
      ...rows.map((r) => [label(r.window), r.chain, r.events, r.positions, r.inScope, r.usdcOnly, r.usdcMixed, r.excluded, usd(r.liquidatedDebtUsd), usd(r.grossBonusUsd)]),
      ['**All**', '', total.events, total.positions, total.inScope, total.usdcOnly, total.usdcMixed, total.excluded, usd(total.liquidatedDebtUsd), usd(total.grossBonusUsd)],
    ],
  );
}

function exclusionTable(rows: Exclusion[]): string {
  return table(['Why excluded', 'Positions', 'Debt liquidated'], rows.map((r) => [r.reason, r.positions, usd(r.liquidatedDebtUsd)]));
}

function savedPivot(cells: Cell[], target: number, delaySec: number): string {
  const rows = GRID.triggers
    .filter((t) => t < target)
    .map((trigger) => [
      trigger.toFixed(2),
      ...GRID.reserveShares.map((r) => {
        const cell = find(cells, trigger, target, r, delaySec);
        return `${cell.saved} (${pct(cell.saved, cell.positions)})`;
      }),
    ]);
  return table(['T \\ R', ...GRID.reserveShares.map(share)], rows);
}

function bonusPivot(cells: Cell[], target: number, delaySec: number): string {
  const rows = GRID.triggers
    .filter((t) => t < target)
    .map((trigger) => [trigger.toFixed(2), ...GRID.reserveShares.map((r) => usd(find(cells, trigger, target, r, delaySec).bonusAvoidedUsd))]);
  return table(['T \\ R', ...GRID.reserveShares.map(share)], rows);
}

function missTable(cell: Cell): string {
  const row = (name: string, count: number, meaning: string): Array<string | number> => [name, count, pct(count, cell.positions), meaning];
  return table(
    ['Outcome', 'Positions', 'Share', 'Meaning'],
    [
      row('saved', cell.reasons.saved, 'Repay landed first, and HF stayed at or above 1 to the end of the window'),
      row('no_warning', cell.reasons.no_warning, 'HF never showed below T in any observation before the liquidation block'),
      row('too_slow', cell.reasons.too_slow, 'HF crossed T, but a liquidator won the race'),
      row('reserve_empty', cell.reasons.reserve_empty, 'Repays landed, the reserve ran out, and HF still fell below 1'),
      row('usdc_debt_exhausted', cell.reasons.usdc_debt_exhausted, 'Repays landed, all USDC debt was gone, and HF still fell below 1'),
      row('follow_up_too_slow', cell.reasons.follow_up_too_slow, 'Reserve remained, but the next repay was in flight or cooling down when HF fell below 1'),
    ],
  );
}

function warningRows(rows: WarningRow[]): string {
  const limits = ['10', '30', '60', '120', '300', '900', '3600'];
  return table(
    ['T', 'Median gap', ...limits.map((l) => `≥ ${duration(Number(l))}`), 'Below T since arming', 'Never below T'],
    rows.map((r) => [
      r.trigger.toFixed(2),
      duration(r.medianGapSec),
      ...limits.map((l) => pct(r.atLeast[l] ?? 0, r.positions)),
      pct(r.belowSinceArming, r.positions),
      pct(r.neverBelowBeforeLiquidation, r.positions),
    ]),
  );
}

function fairTable(rows: FairRow[]): string {
  return table(
    ['R', 'Levee', 'Same USDC as collateral', 'Same USDC repaid at arming', 'Both survive', 'Levee only', 'Collateral only', 'Neither'],
    rows.map((r) => [
      share(r.reserveShare),
      `${r.levee} (${pct(r.levee, r.positions)})`,
      `${r.holdAsCollateral} (${pct(r.holdAsCollateral, r.positions)})`,
      `${r.repayAtArming} (${pct(r.repayAtArming, r.positions)})`,
      r.both,
      r.leveeOnly,
      r.collateralOnly,
      r.neither,
    ]),
  );
}

function groupTable(rows: GroupRow[], first: string): string {
  return table(
    [first, 'Positions', 'Saved', 'Saved %', 'Bonus avoided', 'Bonus at risk', 'Reserve used on saved'],
    rows.map((r) => [r.group, r.positions, r.saved, pct(r.saved, r.positions), usd(r.bonusAvoidedUsd), usd(r.bonusAtRiskUsd), usd(r.reserveUsedOnSavedUsd)]),
  );
}

function fullGrid(cells: Cell[], excluded: number): string {
  return table(
    ['T', 'G', 'R', 'D', 'In scope', 'Excluded', 'Saved', 'Not saved', 'Armed below T', 'no_warning', 'too_slow', 'reserve_empty', 'usdc_exhausted', 'follow_up', 'Bonus avoided', 'Reserve held', 'Reserve used'],
    cells.map((c) => [
      c.trigger.toFixed(2),
      c.target.toFixed(2),
      share(c.reserveShare),
      `${c.delaySec} s`,
      c.positions,
      excluded,
      c.saved,
      c.notSaved,
      c.savedArmedBelowTrigger,
      c.reasons.no_warning,
      c.reasons.too_slow,
      c.reasons.reserve_empty,
      c.reasons.usdc_debt_exhausted,
      c.reasons.follow_up_too_slow,
      usd(c.bonusAvoidedUsd),
      usd(c.reserveHeldUsd),
      usd(c.reserveUsedOnSavedUsd),
    ]),
  );
}

function examples(rows: Example[]): string {
  return table(
    ['Case', 'Chain', 'Borrower', 'Debt', 'HF at arming', 'First below T', 'First liquidation', 'Result', 'Tx'],
    rows.map((e) => [e.label, e.chain, `\`${e.user}\``, usd(e.debtUsd), e.hfAtArming.toFixed(3), e.firstBelowTrigger ?? 'never', e.liquidation, e.reason, `\`${e.tx}\``]),
  );
}

export function renderSummary(summary: Summary): string {
  const { grid, headline } = summary;
  const main = find(grid, HEADLINE.trigger, HEADLINE.target, HEADLINE.reserveShare, HEADLINE.delaySec);
  const v = summary.validation;
  const out: string[] = [];
  out.push('# Levee backtest results');
  out.push('');
  out.push('Generated by `pnpm backtest` from the committed files in `backtest/data/derived`. Method and assumptions are in `backtest/README.md`.');
  out.push('');
  out.push('Every number assumes the keeper, RPCs, NEAR and the MPC network all worked in the worst minutes of the event, with a fixed delay. None of that has been run end to end. A saved position here is a simulation result, not a rescue that happened.');
  out.push('');
  out.push(`## Headline: T ${HEADLINE.trigger.toFixed(2)}, G ${HEADLINE.target.toFixed(2)}, R ${share(HEADLINE.reserveShare)} of debt, D ${HEADLINE.delaySec} s`);
  out.push('');
  out.push(`Of **${main.positions}** in-scope positions, **${main.saved} (${pct(main.saved, main.positions)})** were saved and **${main.notSaved} (${pct(main.notSaved, main.positions)})** were not.`);
  out.push(`${main.savedArmedBelowTrigger} of the saved positions were already below the trigger when armed, so the repay fired at arming and not during the crash. That is an upfront repay, not a rescue. Without them, ${main.saved - main.savedArmedBelowTrigger} (${pct(main.saved - main.savedArmedBelowTrigger, main.positions)}).`);
  out.push(`Gross liquidation bonus avoided on saved positions: **${usd(main.bonusAvoidedUsd)}** of ${usd(main.bonusAtRiskUsd)} at risk (first episode only). Reserve used on saved positions: ${usd(main.reserveUsedOnSavedUsd)}, from ${usd(main.reserveHeldUsd)} held across all in-scope positions.`);
  out.push(`Holding the same USDC as Aave collateral from the start, with no keeper at all: **${headline.fair.holdAsCollateral}** survive (${pct(headline.fair.holdAsCollateral, headline.fair.positions)}). Levee only: ${headline.fair.leveeOnly}. Collateral only: ${headline.fair.collateralOnly}.`);
  out.push('');
  out.push('## Population');
  out.push('');
  out.push(populationTable(summary.population));
  out.push('');
  out.push('A position is one borrower on one chain in one window. Its race is against its first liquidation in that window.');
  out.push('');
  out.push('## Excluded positions');
  out.push('');
  out.push('A position is in scope if it held native USDC variable debt at the block before its first liquidation. Mixed-debt positions stay in scope, with repays capped at their USDC debt.');
  out.push('');
  out.push(exclusionTable(summary.exclusions));
  out.push('');
  out.push('## Warning time');
  out.push('');
  out.push('Time from the start of the final descent through T to the first liquidation, over in-scope positions. It does not depend on the reserve, and it bounds what any rescue with that delay can do.');
  out.push('');
  out.push(warningRows(summary.warning));
  out.push('');
  out.push(`## Saved positions by T, R and D, G ${HEADLINE.target.toFixed(2)}`);
  for (const delay of GRID.delaysSec) {
    out.push('');
    out.push(`D = ${delay} s`);
    out.push('');
    out.push(savedPivot(grid, HEADLINE.target, delay));
  }
  out.push('');
  out.push(`## Gross bonus avoided by T and R, G ${HEADLINE.target.toFixed(2)}, D ${HEADLINE.delaySec} s`);
  out.push('');
  out.push(bonusPivot(grid, HEADLINE.target, HEADLINE.delaySec));
  out.push('');
  out.push('## Misses at the headline cell');
  out.push('');
  out.push(missTable(main));
  out.push('');
  out.push(`${main.failedLaterInWindow} of the misses beat the first real liquidation and fell below 1 later, on the frozen portfolio.`);
  out.push('');
  out.push('## The fair comparison');
  out.push('');
  out.push(`T ${HEADLINE.trigger.toFixed(2)}, G ${HEADLINE.target.toFixed(2)}, D ${HEADLINE.delaySec} s. "Same USDC as collateral" supplies the reserve to Aave at arming. "Repaid at arming" is the bound for any rescue of that size, with no delay and no trigger.`);
  out.push('');
  out.push(fairTable(summary.fair));
  out.push('');
  out.push(summary.fairNote);
  out.push('');
  out.push('## Headline cell by window, chain and size');
  out.push('');
  out.push(groupTable(summary.byWindow, 'Window'));
  out.push('');
  out.push(groupTable(summary.byChain, 'Chain'));
  out.push('');
  out.push(groupTable(summary.byDebtScope, 'Debt'));
  out.push('');
  out.push(groupTable(summary.bySize, 'Debt at liquidation'));
  out.push('');
  out.push(`Size buckets: ${SIZE_BUCKETS.map((b) => b.label).join(', ')}.`);
  out.push('');
  out.push('## Real examples to check by hand');
  out.push('');
  out.push(examples(summary.examples));
  out.push('');
  out.push('## Validation');
  out.push('');
  out.push(table(['Check', 'Result'], v.map((row) => [row.check, row.result])));
  out.push('');
  out.push('## Full grid');
  out.push('');
  out.push(fullGrid(grid, summary.excludedPositions));
  out.push('');
  return out.join('\n');
}
