// Writes results/collateral.json and results/collateral.md. Offline, like the rest of the run.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS_DIR, writeJson } from '../paths.ts';
import { renderCollateral } from './render.ts';
import { buildCollateral } from './report.ts';

export function runCollateral(): void {
  const report = buildCollateral();
  writeJson(join(RESULTS_DIR, 'collateral.json'), report);
  writeFileSync(join(RESULTS_DIR, 'collateral.md'), renderCollateral(report));
  for (const period of report.periods) {
    for (const cap of report.rules.slippageBps) {
      const row = report.population.find((r) => r.period === period.period && r.chain === 'all' && r.trigger === report.base.trigger && r.slippageBps === cap && r.tier === 'cheapest')!;
      console.log(`collateral ${period.period} ${cap} bps: saved ${row.saved} of ${row.liquidated}, bonus avoided $${Math.round(row.bonusAvoided)}, swap cost $${Math.round(row.swapCost)}, gas $${Math.round(row.gas)}`);
    }
  }
  console.log(`wrote ${join(RESULTS_DIR, 'collateral.json')} and collateral.md`);
}

if (import.meta.url === `file://${process.argv[1]}`) runCollateral();
