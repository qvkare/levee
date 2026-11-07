"use client";

import { useEffect, useId, useRef, useState } from "react";
import { percent, plainShare, ratio, usd } from "@/lib/format.ts";
import { LAST_STRETCH, approxFall, simulateRescue } from "@/lib/math.ts";
import type { RowModel } from "@/lib/wall.ts";
import { MAX_FALL_PERCENT, parseFall } from "@/lib/what-if.ts";
import { Num } from "./num.tsx";
import { Axis, Run, cssVars } from "./wall.tsx";

const TARGET_GAP = 0.05;

export interface SimulatorTerms {
  liquidationThreshold: number;
  liquidationBonus: number;
  /** Where those two came from, in words. */
  source: string;
}

function simRow(id: string, name: string, health: number | null, line: string, line2: string): RowModel {
  const distance = health === null ? 1 : approxFall(health);
  return { id, name, line, line2, short: line, percent: health === null ? "No debt" : percent(distance), d: Math.max(0.01, Math.round(distance * 10_000) / 100), tier: "large", hollow: false };
}

function Field({ label, value, min, max, step, onChange }: { label: string; value: number | string; min: number; max: number; step: number; onChange: (value: number) => void }) {
  return (
    <label className="term">
      {label}
      <input
        type="number"
        inputMode="decimal"
        defaultValue={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next) && next >= min && next <= max) onChange(next);
        }}
      />
    </label>
  );
}

/** Same functions as /api/risk. Nothing here is a read, and the page says so in every state. */
export function Simulator({ terms }: { terms: SimulatorTerms }) {
  const id = useId();
  const section = useRef<HTMLElement>(null);
  const [inView, setInView] = useState(false);
  const [collateralUsd, setCollateral] = useState(100_000);
  const [debtUsd, setDebt] = useState(50_000);
  const [reserveUsd, setReserve] = useState(20_000);
  const [trigger, setTrigger] = useState(1.2);
  const [chosenTarget, setTarget] = useState(1.5);
  const [fallPercent, setFall] = useState(30);

  // A link can open the simulator at a given fall.
  useEffect(() => {
    const fall = parseFall(new URLSearchParams(window.location.search).get("fall"));
    if (fall !== null) setFall(Math.round(fall * 100));
  }, []);

  // The red page belongs to this section, so it lifts when the section leaves the screen.
  useEffect(() => {
    const node = section.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => setInView(entry?.isIntersecting ?? false), { threshold: 0.3 });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const target = Math.max(chosenTarget, trigger + TARGET_GAP);
  const { liquidationThreshold, liquidationBonus } = terms;
  const shared = { collateralUsd, liquidationThreshold, debtUsd, fall: fallPercent / 100, trigger, target, liquidationBonus };
  const withLevee = simulateRescue({ ...shared, reserveUsd });
  const without = simulateRescue({ ...shared, reserveUsd: 0 });

  const healthWithout = without.healthAfter;
  const healthWith = withLevee.healthAfter;
  const distanceWithout = healthWithout === null ? null : approxFall(healthWithout);
  const lastStretch = distanceWithout !== null && distanceWithout < LAST_STRETCH;
  const liquidation = without.liquidation;
  const ranOut = withLevee.triggered && withLevee.repaidUsd < withLevee.neededUsd;

  const withoutLine = healthWithout === null ? "No debt" : `Health factor ${ratio(healthWithout)}`;
  const withoutNote = liquidation ? `A liquidator repays ${usd(liquidation.repaidUsd)}` : "Nothing repays it";
  const withLine = healthWith === null ? "All debt repaid" : `Health factor ${ratio(healthWith)}`;
  const withNote = !withLevee.triggered ? `The keeper holds until ${trigger.toFixed(2)}` : ranOut ? `${usd(withLevee.repaidUsd)} repaid, reserve empty` : `${usd(withLevee.repaidUsd)} repaid, ${usd(withLevee.reserveLeftUsd)} left`;
  const rows = [simRow("without", "Without Levee", healthWithout, withoutLine, withoutNote), simRow("with", "With Levee", healthWith, withLine, withNote)];

  const fallMax = MAX_FALL_PERCENT / 100;
  const atTrigger = withLevee.fallToTrigger;
  const atLine = withLevee.fallToLiquidation;
  const state = lastStretch ? (liquidation ? "Liquidators can act." : "Inside the last 5%.") : withLevee.triggered ? "The keeper fires." : "The keeper holds.";

  return (
    <section ref={section} id="try" className="sim" aria-labelledby={`${id}-title`} data-crisis={lastStretch && inView ? "on" : undefined}>
      <div className="sim-head">
        <h2 id={`${id}-title`}>Try a position</h2>
        <p>
          <b>Simulation.</b> Example terms, not a reading. {terms.source}
        </p>
      </div>

      <div className="sim-field">
        {lastStretch ? (
          <div className="sim-crit">
            <p className="crit">{percent(distanceWithout ?? 0)}</p>
            <p className="rest">
              Without Levee, {healthWithout === null ? "no debt" : `health factor ${ratio(healthWithout)}`}. {liquidation ? `A liquidator repays ${usd(liquidation.repaidUsd)} and takes ${usd(liquidation.takenUsd)} of collateral, ${usd(liquidation.bonusUsd)} of it the bonus.` : "Nothing repays it."}
              <br />
              With Levee, {healthWith === null ? "all debt repaid" : `${percent(approxFall(healthWith))} away, health factor ${ratio(healthWith)}`}: {withLevee.triggered ? `${usd(withLevee.repaidUsd)} from the reserve${ranOut ? ", which ran out" : ""}.` : "the keeper has not fired."}
            </p>
          </div>
        ) : (
          <>
            <Run rows={rows} label="The same position without Levee and with it, by distance from liquidation" />
            <div className="mark" style={cssVars({ "--t": approxFall(trigger) * 100 })} aria-hidden="true">
              <span>Trigger {trigger.toFixed(2)}</span>
            </div>
            <div className="mark" style={cssVars({ "--t": approxFall(target) * 100 })} aria-hidden="true">
              <span>Target {target.toFixed(2)}</span>
            </div>
            <Axis />
          </>
        )}
      </div>

      <p className="vh" role="status">
        {state}
      </p>

      <div className="sim-fall">
        <label htmlFor={`${id}-fall`}>
          Price fall <output htmlFor={`${id}-fall`}>{fallPercent}%</output>
        </label>
        <div className="track">
          {atTrigger !== null && atTrigger < fallMax && (
            <span className="track-mark" data-flip={atTrigger > 0.25 || undefined} style={cssVars({ "--at": atTrigger / fallMax })} aria-hidden="true">
              <span className="who">Keeper </span>fires, {percent(atTrigger)}
            </span>
          )}
          {atLine !== null && atLine < fallMax && (
            <span className="track-mark" data-flip={atLine > 0.72 || undefined} style={cssVars({ "--at": atLine / fallMax })} aria-hidden="true">
              Liquidation, {percent(atLine)}
            </span>
          )}
          <input
            id={`${id}-fall`}
            type="range"
            min={0}
            max={MAX_FALL_PERCENT}
            step={1}
            value={fallPercent}
            aria-valuetext={`${fallPercent}% fall. ${withoutLine} without Levee. ${withLine} with Levee.`}
            onChange={(event) => setFall(Number(event.target.value))}
          />
        </div>
      </div>

      <div className="terms">
        <Field label="Collateral, $" value={collateralUsd} min={0} max={1_000_000_000} step={1000} onChange={setCollateral} />
        <Field label="Debt, $" value={debtUsd} min={0} max={1_000_000_000} step={1000} onChange={setDebt} />
        <Field label="Reserve, $" value={reserveUsd} min={0} max={1_000_000_000} step={1000} onChange={setReserve} />
        <Field label="Trigger" value={trigger.toFixed(2)} min={1.01} max={3} step={0.05} onChange={setTrigger} />
        <Field label="Target" value={chosenTarget.toFixed(2)} min={1.05} max={3} step={0.05} onChange={setTarget} />
      </div>

      <div className="sim-out">
        <div className="scroll">
          <table className="nums">
            <thead>
              <tr>
                <th scope="col">After this fall</th>
                <th scope="col">Health factor</th>
                <th scope="col">Debt</th>
                <th scope="col" className="wide narrow-hide">
                  Collateral
                </th>
                <th scope="col">Repaid from reserve</th>
                <th scope="col">Bonus paid</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Without Levee</td>
                <td className="strong">
                  <Num>{healthWithout === null ? "no debt" : ratio(healthWithout)}</Num>
                </td>
                <td>
                  <Num>{usd(liquidation?.debtLeftUsd ?? debtUsd)}</Num>
                </td>
                <td className="wide narrow-hide">
                  <Num>{usd(liquidation?.collateralLeftUsd ?? without.collateralAfterFallUsd)}</Num>
                </td>
                <td className="soft">none</td>
                <td className={liquidation ? undefined : "soft"}>{liquidation ? <Num>{usd(liquidation.bonusUsd)}</Num> : "none"}</td>
              </tr>
              <tr>
                <td>With Levee</td>
                <td className="strong">
                  <Num>{healthWith === null ? "no debt" : ratio(healthWith)}</Num>
                </td>
                <td>
                  <Num>{usd(withLevee.liquidation?.debtLeftUsd ?? debtUsd - withLevee.repaidUsd)}</Num>
                </td>
                <td className="wide narrow-hide">
                  <Num>{usd(withLevee.liquidation?.collateralLeftUsd ?? withLevee.collateralAfterFallUsd)}</Num>
                </td>
                <td className={withLevee.repaidUsd > 0 ? undefined : "soft"}>{withLevee.repaidUsd > 0 ? <Num>{usd(withLevee.repaidUsd)}</Num> : "none"}</td>
                <td className={withLevee.liquidation ? undefined : "soft"}>{withLevee.liquidation ? <Num>{usd(withLevee.liquidation.bonusUsd)}</Num> : "none"}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="note">
          Uses a {plainShare(liquidationThreshold)} liquidation threshold and a {plainShare(liquidationBonus)} bonus. All collateral falls together, the debt holds its value, and all of the debt is USDC. The repay lands at this price, so the race with a liquidator is left out: <a href="/proof">the backtest</a> measures that.
        </p>
      </div>
    </section>
  );
}
