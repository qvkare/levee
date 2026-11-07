/** Backtest and signing figures for the report page, inlined at build time by next.config.ts. */
export interface Brief {
  backtest: {
    positions: number;
    trigger: number;
    target: number;
    delaySec: number;
    rows: Array<{ reserveShare: number; leveeShare: number; collateralShare: number }>;
  } | null;
  signing: { signed: number; runs: number; p50Ms: number | null; slowestMs: number | null } | null;
}

export const BRIEF: Brief = JSON.parse(process.env.LEVEE_BRIEF ?? '{"backtest":null,"signing":null}');
