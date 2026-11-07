"use client";

import { useMemo, useState } from "react";
import { CHAINS } from "@/lib/chains.ts";
import { usd } from "@/lib/format.ts";
import { MAX_TARGET, MIN_TARGET } from "@/lib/math.ts";
import { chartModel, verdict } from "@/lib/reading.ts";
import { withTarget } from "@/lib/report.ts";
import type { AaveMarket, RiskReport } from "@/lib/types.ts";
import { AaveStation } from "./aave-station.tsx";
import { HyperliquidStation } from "./hyperliquid-station.tsx";
import { SectionChart } from "./section-chart.tsx";

function repaySentence(markets: AaveMarket[], target: number): string {
  const figures = markets
    .filter((market) => market.position?.repay)
    .map((market) => {
      const needed = market.position?.repay?.usd ?? 0;
      const { label } = CHAINS[market.chain];
      return needed > 0 ? `Repay ${usd(needed)} on ${label} to reach ${target.toFixed(2)}.` : `${label} is already at or above ${target.toFixed(2)}.`;
    });
  // A chain that did not answer may hold debt too. Saying so keeps the figure honest.
  const unread = markets.filter((market) => market.status === "unavailable").map((market) => `${CHAINS[market.chain].label} was not read.`);
  return [...figures, ...unread].join(" ");
}

export function Report({ report: initial }: { report: RiskReport }) {
  const [target, setTarget] = useState(initial.target);
  const report = useMemo(() => withTarget(initial, target), [initial, target]);
  const model = useMemo(() => chartModel(initial), [initial]);
  const answer = verdict(initial);
  const markets = [report.aave.base, report.aave.arbitrum];
  const hasRepay = markets.some((market) => market.position?.repay);
  const failureFor = (source: string) => report.failures.find((failure) => failure.source === source);

  function choose(value: number) {
    setTarget(value);
    // Keeps the chosen target in the link, so a shared page opens the same way.
    const url = new URL(window.location.href);
    url.searchParams.set("target", value.toFixed(2));
    window.history.replaceState(null, "", url);
  }

  return (
    <>
      <div className="wrap report-head">
        <p className="verdict" data-stage={answer.stage ?? undefined}>
          {answer.text}
        </p>
        {report.failures.length > 0 && (
          <div className="failures">
            <p className="medium">Some figures are missing, and they are not zero:</p>
            <ul>
              {report.failures.map((failure) => (
                <li key={failure.message}>{failure.message}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <SectionChart model={model} target={hasRepay ? target : null} label="River section for this address" />

      <div className="wrap">
        {hasRepay && (
          <>
            <form className="target-control" method="get">
              <label htmlFor="target">Target health factor</label>
              <input
                id="target"
                name="target"
                type="range"
                min={MIN_TARGET}
                max={MAX_TARGET}
                step={0.05}
                value={target}
                onChange={(event) => choose(Number(event.target.value))}
                aria-valuetext={target.toFixed(2)}
                aria-describedby="repay-output"
              />
              <span className="target-value water-label">{target.toFixed(2)}</span>
              <noscript>
                <button className="button" type="submit">
                  Set target
                </button>
              </noscript>
            </form>
            <output id="repay-output" className="repay-output" htmlFor="target">
              {repaySentence(markets, target)}
            </output>
          </>
        )}
        <p className="chart-caption">
          Water rises as health falls. At 1.00 it reaches the crest and liquidation can start. The Stage face reads health factor. The Fall face is the same height as an approximate fall to liquidation.
          The levee stands for the reserve: repaying debt draws the water down to the target line.
        </p>

        {markets.map((market) => (
          <AaveStation key={market.chain} market={market} failure={failureFor(`aave.${market.chain}`)} />
        ))}
        <HyperliquidStation account={report.hyperliquid} failures={report.failures.filter((failure) => failure.source === "hyperliquid")} />

        <section className="station">
          <h2>Check this yourself</h2>
          <p className="station-meta">
            This page reads. It does not protect anything. The same data is at{" "}
            <a href={`/api/risk?address=${report.address}&target=${target.toFixed(2)}`}>/api/risk</a> as JSON, with the exact contract outputs and the block number, so any figure here can be repeated
            with a direct call.
          </p>
        </section>
      </div>
    </>
  );
}
