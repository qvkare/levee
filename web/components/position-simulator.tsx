"use client";

import { useState } from "react";
import type { DrillTerms } from "@/lib/drill.ts";
import { STAGE_NAMES, integer, percent, share, stageValue, usd } from "@/lib/format.ts";
import { OVERTOP_Y, chartY } from "@/lib/gauge.ts";
import { approxFall, simulateRescue, stageForHealth } from "@/lib/math.ts";
import { RiverSection } from "./river-section.tsx";
import { Slider } from "./slider.tsx";

const TARGET_GAP = 0.05;

function keeperLine(triggered: boolean, reserveUsd: number, repaidUsd: number, neededUsd: number): string {
  if (!triggered) return "Holds";
  if (reserveUsd === 0) return "Fires, but the reserve is empty";
  return repaidUsd < neededUsd ? "Fires, and the reserve runs out" : "Fires";
}

/** Same maths as /api/risk and the drill. Nothing here is a read. */
export function PositionSimulator({ terms }: { terms: DrillTerms }) {
  const [collateralUsd, setCollateral] = useState(100_000);
  const [debtUsd, setDebt] = useState(50_000);
  const [fallPercent, setFallPercent] = useState(0);
  const [trigger, setTrigger] = useState(1.2);
  const [target, setTarget] = useState(1.5);
  const [reserveUsd, setReserve] = useState(20_000);

  const { liquidationThreshold, liquidationBonus } = terms;
  const result = simulateRescue({ collateralUsd, liquidationThreshold, debtUsd, fall: fallPercent / 100, trigger, target, reserveUsd, liquidationBonus });
  const { healthBefore, healthAfterFall, healthAfter, liquidation } = result;
  const stage = stageForHealth(healthAfter);
  const over = stage === "flood";
  const dry = healthAfter === null;
  const waterY = dry ? null : over ? OVERTOP_Y : chartY(approxFall(healthAfter));
  const source = terms.source === "example" ? "an example position" : `${terms.label} at block ${integer(terms.blockNumber ?? 0)}`;

  const chooseTrigger = (value: number) => {
    setTrigger(value);
    if (target < value + TARGET_GAP) setTarget(value + TARGET_GAP);
  };
  const chooseTarget = (value: number) => setTarget(Math.max(value, trigger + TARGET_GAP));

  return (
    <div className="simulator">
      <div className="sim-controls">
        <Slider id="sim-collateral" label="Collateral" value={collateralUsd} min={1000} max={1_000_000} step={1000} display={usd(collateralUsd)} onChange={setCollateral} />
        <Slider id="sim-debt" label="Debt" value={debtUsd} min={0} max={1_000_000} step={500} display={usd(debtUsd)} onChange={setDebt} />
        <Slider id="sim-fall" label="Price fall" value={fallPercent} min={0} max={90} step={1} display={`${fallPercent}%`} onChange={setFallPercent} />
        <Slider id="sim-trigger" label="Trigger" value={trigger} min={1.05} max={2} step={0.05} display={trigger.toFixed(2)} onChange={chooseTrigger} />
        <Slider id="sim-target" label="Target" value={target} min={1.1} max={3} step={0.05} display={target.toFixed(2)} onChange={chooseTarget} />
        <Slider id="sim-reserve" label="Reserve" value={reserveUsd} min={0} max={200_000} step={500} display={usd(reserveUsd)} onChange={setReserve} />
      </div>

      <div>
        <RiverSection
          state={over ? "over" : dry ? "dry" : "reading"}
          waterY={waterY}
          fit="column"
          lines={dry ? [] : [{ id: "trigger", y: chartY(approxFall(trigger)), label: `Trigger ${trigger.toFixed(2)}` }, { id: "target", y: chartY(approxFall(target)), label: `Target ${target.toFixed(2)}` }]}
          summary={dry ? "Dry channel. No debt." : `River section. Health factor ${stageValue(healthAfter)}, ${STAGE_NAMES[stage]}.`}
        >
          {waterY !== null ? (
            <div className="chart-reading" style={{ transform: `translateY(${waterY}%)` }} aria-hidden="true">
              <p className="water-label">Stage {stageValue(healthAfter as number)}</p>
            </div>
          ) : (
            <p className="chart-empty water-label">Dry channel</p>
          )}
        </RiverSection>

        <p className={over ? "sim-stage flood-text" : "sim-stage"} aria-live="polite">
          {dry ? "Dry. No debt, so nothing to liquidate." : `${STAGE_NAMES[stage]}. Health factor ${stageValue(healthAfter)}.`}
        </p>

        <dl className="readout">
          {healthBefore !== null && (
            <div className="readout-row">
              <dt>Health factor today</dt>
              <dd>{stageValue(healthBefore)}</dd>
            </div>
          )}
          {healthAfterFall !== null && fallPercent > 0 && (
            <div className="readout-row">
              <dt>After a {fallPercent}% fall</dt>
              <dd>{stageValue(healthAfterFall)}</dd>
            </div>
          )}
          {result.fallToTrigger !== null && (
            <div className="readout-row">
              <dt>Fall to the trigger</dt>
              <dd>{percent(result.fallToTrigger)}</dd>
            </div>
          )}
          {result.fallToFlood !== null && (
            <div className="readout-row">
              <dt>Fall to flood stage, about</dt>
              <dd>{percent(result.fallToFlood)}</dd>
            </div>
          )}
          {!dry && (
            <div className="readout-row">
              <dt>Keeper</dt>
              <dd>{keeperLine(result.triggered, reserveUsd, result.repaidUsd, result.neededUsd)}</dd>
            </div>
          )}
          {result.triggered && (
            <>
              <div className="readout-row">
                <dt>Repay to reach {target.toFixed(2)}</dt>
                <dd>{usd(result.neededUsd)}</dd>
              </div>
              <div className="readout-row">
                <dt>Repaid from the reserve</dt>
                <dd>{usd(result.repaidUsd)}</dd>
              </div>
              <div className="readout-row">
                <dt>Reserve left</dt>
                <dd>{usd(result.reserveLeftUsd)}</dd>
              </div>
            </>
          )}
          {liquidation && (
            <div className="readout-row flood-text">
              <dt>If a liquidator acts here</dt>
              <dd>
                Repays {usd(liquidation.repaidUsd)}, takes {usd(liquidation.takenUsd)}
              </dd>
            </div>
          )}
        </dl>
        <p className="note">
          Simulation, using a {share(liquidationThreshold)} liquidation threshold and a {share(liquidationBonus)} bonus from {source}. All collateral falls together and the debt holds its value. Levee
          repays USDC debt only, and this assumes all of the debt is USDC.
        </p>
      </div>
    </div>
  );
}
