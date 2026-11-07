// The parameter grid. Delays cover the brief's 30 to 300 s, plus 10 s, the tail estimate
// for a rescue paid from float already on the lending chain (not measured end to end yet).
export const GRID = {
  triggers: [1.05, 1.1, 1.15, 1.2, 1.3],
  targets: [1.35, 1.5],
  reserveShares: [0.05, 0.1, 0.2, 0.3, 0.5],
  delaysSec: [10, 30, 60, 120, 300],
} as const;

/** The spec leaves cooldown_secs to the owner. This is the value the backtest assumes. */
export const COOLDOWN_SEC = 60;
