import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { readPrices } from '../src/data.ts';
import type { MarketSnapshot } from '../src/fetch/reserves.ts';
import { DERIVED_DIR, readJson } from '../src/paths.ts';
import { readPopulation } from '../src/portfolio/data.ts';
import { PeriodModel } from '../src/portfolio/model.ts';
import { simulateTracked } from '../src/sim/tracked.ts';

// On a committed population file: skipping stretches where HF provably stays at or above the
// highest trigger must change nothing the keeper does. Takes several seconds.
describe('skipping rows above the highest trigger, on Arbitrum 2025-10', () => {
  const file = readPopulation('arbitrum', '2025-10');
  const prices = readPrices().find((p) => p.chain === 'arbitrum' && p.window === '2025-10')!;
  const market = readJson<MarketSnapshot[]>(join(DERIVED_DIR, 'markets.json')).find((m) => m.chain === 'arbitrum' && m.window === '2025-10' && m.block === file.fromBlock)!;
  const fast = new PeriodModel(file, prices, market, true);
  const full = new PeriodModel(file, prices, market, false);

  it('gives the same lowest HF below the highest trigger, and the same keeper outcomes', () => {
    let compared = 0;
    for (let m = 0; m < file.members.length; m++) {
      const a = fast.build(m);
      const b = full.build(m);
      assert.equal(a === null, b === null);
      if (!a || !b) continue;
      assert.equal(a.minHf < 1.3, b.minHf < 1.3, a.user);
      if (b.minHf < 1.3) assert.equal(a.minHf, b.minHf, a.user);
      if (b.minHf >= 1.3 && !b.path.liquidation) continue;
      for (const trigger of [1.05, 1.2, 1.3]) {
        const params = { trigger, target: 1.5, reserveShare: 0.3, delaySec: 60, cooldownSec: 60 };
        const x = simulateTracked(a.path, params);
        const y = simulateTracked(b.path, params);
        assert.equal(x.saved, y.saved, a.user);
        assert.equal(x.firstDetection, y.firstDetection, a.user);
        assert.ok(Math.abs(x.fired - y.fired) <= 1e-9 * Math.max(1, y.fired), `${a.user} ${x.fired} ${y.fired}`);
        compared++;
      }
    }
    assert.ok(fast.skipped.rows > 0);
    assert.ok(compared > 1000, `${compared} compared`);
  });
});
