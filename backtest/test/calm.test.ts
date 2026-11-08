import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chooseCalm, dailyMoves } from '../src/calm.ts';
import { baseBlockAt } from '../src/config.ts';

const DAY = 86_400;
const series = (prices: number[]): Array<{ t: number; price: number }> => prices.map((price, i) => ({ t: 1_000 * DAY + i * DAY, price }));

describe('calm-period rule', () => {
  it('measures each day from one midnight to the next', () => {
    const moves = dailyMoves(series([100, 110, 99]));
    assert.equal(moves.length, 2);
    assert.ok(Math.abs(moves[0]! - 0.1) < 1e-12);
    assert.ok(Math.abs(moves[1]! - 0.1) < 1e-12);
  });

  it('takes the centre of the longest run with no day over the limit', () => {
    // Days 0-1 calm, day 2 moves 20%, days 3-9 calm (7 days), day 10 moves 20%, days 11-12 calm.
    const prices = [100, 101, 102, 122.4, 123, 124, 125, 124, 123, 122, 121, 145.2, 146, 147];
    const choice = chooseCalm(series(prices), 0.08, 3);
    assert.equal(choice.runDays, 7);
    assert.equal(choice.runStartTime, 1_000 * DAY + 3 * DAY);
    // floor((7 - 3) / 2) = 2 days into the run.
    assert.equal(choice.startTime, 1_000 * DAY + 5 * DAY);
    assert.equal(choice.endTime, choice.startTime + 3 * DAY);
  });

  it('takes the earliest run on a tie', () => {
    const prices = [100, 101, 102, 130, 131, 132];
    assert.equal(chooseCalm(series(prices), 0.08, 2).runStartTime, 1_000 * DAY);
  });

  it('counts a move just under the limit as calm, and one just over as not', () => {
    assert.equal(chooseCalm(series([100, 107.9, 100]), 0.08, 2).runDays, 2);
    assert.equal(chooseCalm(series([100, 108.1, 100, 100]), 0.08, 1).runDays, 2);
  });

  it('refuses a run shorter than the period', () => {
    assert.throws(() => chooseCalm(series([100, 120, 140]), 0.08, 2));
  });
});

describe('Base block from time', () => {
  it('gives the first block at or after a time, as in data/derived/blocks.json', () => {
    assert.equal(baseBlockAt(Date.parse('2025-10-10T00:00:00Z') / 1000), 36632527);
    assert.equal(baseBlockAt(Date.parse('2026-01-31T00:00:00Z') / 1000), 41514127);
  });
});
