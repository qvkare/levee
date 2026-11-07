// The fair comparison: what the same dollars do with no keeper at all.
// Both baselines use the survival rule `simulate` uses: HF at or above 1 at every point
// from the real liquidation to the end of the window.
import { armingPoint, healthFactor, type PositionPath } from './simulate.ts';

export interface BaselineOutcome {
  survived: boolean;
  minHfFromLiquidation: number;
}

function survive(path: PositionPath, hfAt: (capacity: number, debt: number) => number): BaselineOutcome {
  let minHf = Infinity;
  for (const point of path.points) {
    if (point.block < path.liquidationBlock) continue;
    minHf = Math.min(minHf, hfAt(point.capacity, point.debt));
  }
  return { survived: minHf >= 1, minHfFromLiquidation: minHf };
}

/** The reserve is supplied as USDC collateral at arming. It adds `reserve × LT` of capacity. */
export function holdAsCollateral(path: PositionPath, reserveShare: number, usdcThreshold: number): BaselineOutcome {
  const reserve = reserveShare * armingPoint(path).debt;
  return survive(path, (capacity, debt) => healthFactor(capacity + reserve * usdcThreshold, debt));
}

/** The reserve repays USDC debt at arming. This is the bound for any rescue of the same size. */
export function repayAtArming(path: PositionPath, reserveShare: number): BaselineOutcome {
  const reserve = reserveShare * armingPoint(path).debt;
  return survive(path, (capacity, debt) => healthFactor(capacity, Math.max(0, debt - Math.min(reserve, path.usdcShare * debt))));
}
