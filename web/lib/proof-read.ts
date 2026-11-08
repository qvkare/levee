/**
 * Reads the evidence and backtest folders and works out every figure. next.config.ts runs this at
 * build time and inlines the result as LEVEE_PROOF, because a Worker has neither folder.
 */
import { readCollateralBacktest } from "./backtest-collateral.ts";
import { readBacktest } from "./backtest.ts";
import { readClaims, readMpcLatency, readRehearsal, readRuns } from "./evidence.ts";
import { buildProof, type Proof } from "./proof-model.ts";

export function readProof(): Proof {
  return buildProof({ runs: readRuns(), claims: readClaims(), signing: readMpcLatency(), rehearsal: readRehearsal(), backtest: readCollateralBacktest(), reserveBacktest: readBacktest() });
}
