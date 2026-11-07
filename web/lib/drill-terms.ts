/** Picks the drill's real position. It resolves on any outcome, and falls back to a marked example. */
import type { Address } from "viem";
import { readAaveMarket } from "./aave.ts";
import { ttlCache } from "./cache.ts";
import { CHAINS } from "./chains.ts";
import { DRILL_TARGET, DRILL_TRIGGER, EXAMPLE_TERMS, type DrillTerms } from "./drill.ts";
import { DEFAULT_TARGET } from "./math.ts";
import type { AavePosition, ChainKey } from "./types.ts";

/**
 * Public addresses from Aave Borrow logs on 2026-11-07. They suit the drill: USDC debt Levee could
 * repay, volatile collateral, and room to fall. They can close, so the first that still fits is used.
 */
const POSITIONS: Array<{ chain: ChainKey; address: Address }> = [
  { chain: "arbitrum", address: "0x175f2F6A1A70af8Ae33410E368D0FB8E85Ba7B05" },
  { chain: "arbitrum", address: "0x7E1ceC1A83bb62fFC885586cE665aF3dd6fec26d" },
];

const MIN_START_HEALTH = 1.3;

export function suitable(position: AavePosition | null): position is AavePosition {
  return (
    position !== null &&
    position.healthFactor !== null &&
    position.healthFactor >= MIN_START_HEALTH &&
    position.dropToLiquidation?.assumptionHolds === true &&
    (position.repay?.usdcDebtUsd ?? 0) > 0 &&
    position.reserves?.liquidationBonus != null
  );
}

async function read(source: "live" | "built"): Promise<DrillTerms> {
  for (const { chain, address } of POSITIONS) {
    const { market } = await readAaveMarket(chain, address, DEFAULT_TARGET);
    const position = market.position;
    if (!suitable(position)) continue;
    return {
      source,
      label: `Aave on ${CHAINS[chain].label}`,
      address,
      blockNumber: market.blockNumber,
      collateralUsd: position.collateralUsd,
      debtUsd: position.debtUsd,
      liquidationThreshold: position.liquidationThreshold,
      liquidationBonus: position.reserves?.liquidationBonus ?? 0,
      usdcDebtUsd: position.repay?.usdcDebtUsd ?? 0,
      trigger: DRILL_TRIGGER,
      target: DRILL_TARGET,
    };
  }
  return EXAMPLE_TERMS;
}

const cache = ttlCache<DrillTerms>((terms) => (terms.source === "example" ? 0 : 60_000), 2);

export function getDrillTerms(source: "live" | "built"): Promise<DrillTerms> {
  return cache.get(source, () => read(source));
}
