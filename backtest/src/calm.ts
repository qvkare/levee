// The calm-period rule from README.md, as a pure function so a test can check it.
//
// Prices are read at each UTC midnight. Day i runs from midnight i to midnight i + 1, and its
// move is |p[i + 1] / p[i] - 1|. The longest run of days whose moves are all at or below the
// limit wins, the earliest on a tie, and the period is the `days` at its centre.

export interface MidnightPrice {
  /** Unix seconds of the UTC midnight. */
  t: number;
  price: number;
}

export interface CalmChoice {
  runStartTime: number;
  runDays: number;
  startTime: number;
  endTime: number;
  /** Largest daily move inside the chosen period. */
  largestMove: number;
  /** Largest daily move in the whole range read, for scale. */
  largestMoveAnywhere: number;
}

const DAY = 86_400;

export function dailyMoves(prices: MidnightPrice[]): number[] {
  for (let i = 1; i < prices.length; i++) {
    if (prices[i]!.t - prices[i - 1]!.t !== DAY) throw new Error(`midnights not one day apart at ${prices[i]!.t}`);
  }
  return prices.slice(1).map((p, i) => Math.abs(p.price / prices[i]!.price - 1));
}

export function chooseCalm(prices: MidnightPrice[], maxMove: number, days: number): CalmChoice {
  const moves = dailyMoves(prices);
  let best = { start: -1, length: 0 };
  let start = 0;
  for (let i = 0; i <= moves.length; i++) {
    if (i === moves.length || moves[i]! > maxMove) {
      const length = i - start;
      if (length > best.length) best = { start, length };
      start = i + 1;
    }
  }
  if (best.length < days) throw new Error(`longest calm run is ${best.length} days, under ${days}`);
  const first = best.start + Math.floor((best.length - days) / 2);
  return {
    runStartTime: prices[best.start]!.t,
    runDays: best.length,
    startTime: prices[first]!.t,
    endTime: prices[first]!.t + days * DAY,
    largestMove: Math.max(...moves.slice(first, first + days)),
    largestMoveAnywhere: Math.max(...moves),
  };
}
