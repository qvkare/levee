/**
 * The one source of every figure the site states about Levee: runs, hops, signing, the replayed run
 * and the backtest. next.config.ts works it out at build time (proof-read.ts) and inlines it, so a
 * prerendered page and a page rendered on the Worker print the same numbers.
 */
import { EMPTY_PROOF, type Proof } from "./proof-model.ts";

export const PROOF: Proof = (JSON.parse(process.env.LEVEE_PROOF ?? "null") as Proof | null) ?? EMPTY_PROOF;

export { hop } from "./proof-model.ts";
export type { BacktestFigures, BacktestRow, Link, Proof, ProofRun, Replay, Signing } from "./proof-model.ts";
