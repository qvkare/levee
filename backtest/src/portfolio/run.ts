// Writes results/portfolio.json and results/portfolio.md. Offline, like the rest of the run.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS_DIR, writeJson } from '../paths.ts';
import { renderPortfolio } from './render.ts';
import { BASE, buildPortfolio } from './report.ts';

export function runPortfolio(): void {
  const portfolio = buildPortfolio();
  writeJson(join(RESULTS_DIR, 'portfolio.json'), portfolio);
  writeFileSync(join(RESULTS_DIR, 'portfolio.md'), renderPortfolio(portfolio));
  for (const period of portfolio.periods) {
    const row = portfolio.population.find((r) => r.period === period.period && r.chain === 'all' && r.trigger === BASE.trigger && r.reserveShare === BASE.reserveShare)!;
    console.log(`portfolio ${period.period}: ${row.members} members, drawn $${row.drawn} of $${row.reserveHeld} held, $${row.drawnBySurvivors} by survivors`);
  }
  console.log(`wrote ${join(RESULTS_DIR, 'portfolio.json')} and portfolio.md`);
}

if (import.meta.url === `file://${process.argv[1]}`) runPortfolio();
