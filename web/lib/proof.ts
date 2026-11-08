/**
 * The one source of every figure the site states about Levee: runs, hops, signing, the replayed run
 * and both backtests. next.config.ts works it out at build time (proof-read.ts) and inlines it, so a
 * prerendered page and a page rendered on the Worker print the same numbers.
 */
import { EMPTY_PROOF, type Proof } from "./proof-model.ts";

export const PROOF: Proof = (JSON.parse(process.env.LEVEE_PROOF ?? "null") as Proof | null) ?? EMPTY_PROOF;

export { hop, overall } from "./proof-model.ts";
export type { BacktestFigures, BacktestRow, BoundFigures, CollateralFigures, Keyless, Link, Mode, ModeFigures, PeriodFigures, Proof, ProofRun, Replay, Sale, Signing, SizeSplit } from "./proof-model.ts";
