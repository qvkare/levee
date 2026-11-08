import Link from "next/link";
import { countShare, countWord, integer, joined, signedUsdShort, usd, usdShort } from "@/lib/format.ts";
import { PROOF, type BacktestFigures, type BoundFigures, type CollateralFigures, type PeriodFigures } from "@/lib/proof.ts";
import { BacktestChart, boundName } from "./backtest-chart.tsx";

const pct = (fraction: number) => `${Math.round(fraction * 100)}%`;
const share = (fraction: number) => `${(fraction * 100).toFixed(1)}%`;
const both = (period: PeriodFigures, pick: (bound: BoundFigures) => string) => period.bounds.map(pick).join(" / ");
const first = (period: PeriodFigures) => period.bounds[0] as BoundFigures;
const at = (bound: BoundFigures) => `at the ${boundName(bound.bps)}`;
const At = (bound: BoundFigures) => `At the ${boundName(bound.bps)}`;

const crashes = (backtest: CollateralFigures) => backtest.periods.filter((period) => !period.calm);
const calm = (backtest: CollateralFigures) => backtest.periods.find((period) => period.calm) ?? null;
/** The period where a figure is largest, at the tighter bound. */
const largest = (backtest: CollateralFigures, pick: (bound: BoundFigures) => number) => [...backtest.periods].sort((a, b) => pick(first(b)) - pick(first(a)))[0] as PeriodFigures;

export function backtestIntro(backtest: CollateralFigures): string {
  return `Every native USDC borrower on Aave v3 ${joined(backtest.chains)}, through ${countWord(crashes(backtest).length).toLowerCase()} crashes and a calm month, replayed with trigger ${backtest.trigger.toFixed(2)}, target ${backtest.target.toFixed(2)} and a ${backtest.delaySec} second delay. Each sale is priced from a real Uniswap v3 quote at its landing block, against Aave’s oracle in the same block. A simulation: it assumes the keeper, RPCs, NEAR and the MPC network all worked.`;
}

/** What the backtest says, each point worked out from the figures. */
function Findings({ backtest }: { backtest: CollateralFigures }) {
  const crash = crashes(backtest);
  const quiet = calm(backtest);
  const paid = crash.length > 0 && crash.every((period) => period.bounds.every((bound) => bound.net > 0));
  const tight = backtest.bounds[0] as number;
  const fewer = backtest.periods.every((period) => first(period).saved < Math.min(period.reserve.saved, period.upfront.saved));
  const exceptions = backtest.periods.flatMap((period) => period.bounds.slice(1).filter((bound) => bound.saved >= Math.min(period.reserve.saved, period.upfront.saved)).map((bound) => `${integer(bound.saved)} against ${integer(Math.min(period.reserve.saved, period.upfront.saved))} ${at(bound)}, ${period.range}`));
  const size = [...backtest.sizes].filter((row) => row.bps === tight).sort((a, b) => a.smallNet - b.smallNet)[0];
  const sizePeriod = backtest.periods.find((period) => period.key === size?.period);
  return (
    <ul className="prose-list bt-findings">
      {paid && <li>In {crash.length === 2 ? "both crashes" : "every crash"}, repaying from collateral avoided more liquidation bonus than it cost, at both bounds.</li>}
      {quiet && (
        <li>
          In the calm month it cost more than it avoided: net {signedUsdShort(first(quiet).net)} {at(first(quiet))}. Each of the {integer(first(quiet).membersAbove)} borrowers armed above the trigger paid {usd(first(quiet).perMemberAbove)} in swap cost and gas over {quiet.days} days, and sold {share(first(quiet).soldShareAbove)} of their collateral.
        </li>
      )}
      {fewer && (
        <li>
          {At(first(backtest.periods[0] as PeriodFigures))} it saved fewer liquidated positions than the reserve or the same USDC repaid upfront, in every period. Both of those need the cash in hand.
          {exceptions.length > 0 && ` The looser bound saved as many or more ${exceptions.length === 1 ? "once" : `${countWord(exceptions.length).toLowerCase()} times`}: ${exceptions.join("; ")}.`}
        </li>
      )}
      {size && sizePeriod && size.smallNet < 0 && (
        <li>
          In {sizePeriod.range}, {at(first(sizePeriod))}, positions under ${integer(size.threshold / 1000)}k of debt lost {usdShort(-size.smallNet)}, with {usdShort(size.smallGas)} spent on their gas. Larger positions made {usdShort(size.largeNet)}.
        </li>
      )}
    </ul>
  );
}

/**
 * The README's "Read these with the figures", with the figures. It lives inside BacktestBody, so a
 * net figure on the site never stands without it.
 */
export function BacktestCaveats({ backtest }: { backtest: CollateralFigures }) {
  const stale = largest(backtest, (bound) => bound.swapCostNoBetter - bound.swapCost);
  const gas = largest(backtest, (bound) => bound.gas);
  return (
    <div className="note note-plain bt-caveats">
      <h3 className="sub-h">Read these with the figures</h3>
      <ul className="prose-list">
        <li>
          Saved counts include positions already below the trigger when armed, which unwind at once. {At(first(backtest.periods[0] as PeriodFigures))}: {backtest.periods.map((period) => `${integer(first(period).savedArmedBelow)} of ${integer(first(period).saved)} in ${period.range}`).join(", ")}.
        </li>
        <li>
          The {stale.range} swap cost includes gains from pools that lagged a falling oracle. Counting no sale better than the oracle, it is {usdShort(first(stale).swapCostNoBetter)} {at(first(stale))}, and the net is {signedUsdShort(first(stale).netNoBetter)}.
        </li>
        <li>
          The replayed keeper resends a reverted unwind every minute. In {gas.range} gas was high during a spike on Arbitrum, and {pct(first(gas).gasReverted / first(gas).gas)} of it went on reverted unwinds. The live keeper quotes before sending; with no gas on reverts, the net {at(first(gas))} would be {signedUsdShort(first(gas).netNoReverts)}.
        </li>
        <li>Each sale fills at its quote, alone in its block. Infrastructure is up, with a fixed {backtest.delaySec} second delay. Two crashes say nothing about how often crashes happen, so none of this is annualised.</li>
      </ul>
    </div>
  );
}

/** The money, period by period, at both bounds. */
export function BacktestMoney({ backtest }: { backtest: CollateralFigures }) {
  const bounds = backtest.bounds.map((bps) => `${bps / 100}%`).join(" / ");
  const rows: Array<{ label: string; cell: (period: PeriodFigures) => string; strong?: boolean }> = [
    { label: "Borrowers", cell: (period) => integer(period.members) },
    { label: "Liquidated in reality", cell: (period) => integer(period.liquidated) },
    { label: "Bonus at risk, all paid when doing nothing", cell: (period) => usdShort(period.bonusAtRisk) },
    { label: `Saved from collateral, ${bounds}`, cell: (period) => both(period, (bound) => integer(bound.saved)) },
    { label: `Reserve ${pct(backtest.periods[0]?.reserve.share ?? 0)} / same USDC upfront, saved`, cell: (period) => `${integer(period.reserve.saved)} / ${integer(period.upfront.saved)}` },
    { label: `Bonus avoided, ${bounds}`, cell: (period) => both(period, (bound) => usdShort(bound.bonusAvoided)) },
    { label: `Swap cost, ${bounds}`, cell: (period) => both(period, (bound) => usdShort(bound.swapCost)) },
    { label: `Gas, ${bounds}`, cell: (period) => both(period, (bound) => usdShort(bound.gas)) },
    { label: `Net, ${bounds}`, cell: (period) => both(period, (bound) => signedUsdShort(bound.net)), strong: true },
  ];
  return (
    <div className="scroll" tabIndex={0} role="region" aria-label="Backtest money by period">
      <table className="bt-money">
        <thead>
          <tr>
            <th scope="col">Repay from collateral</th>
            {backtest.periods.map((period) => (
              <th key={period.key} scope="col">
                {period.calm ? "Calm month" : "Crash"}
                <small>{period.range}</small>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <th scope="row">{row.label}</th>
              {backtest.periods.map((period) => (
                <td key={period.key} className={row.strong ? "strong" : undefined}>
                  {row.cell(period)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The chart, what it says, the money when asked, and the caveats, which come with the figures everywhere. */
export function BacktestBody({ backtest, money = true }: { backtest: CollateralFigures; money?: boolean }) {
  return (
    <div className="bt-body">
      <div className="card card-white">
        <h3>Liquidated positions saved</h3>
        <p className="cap">Of the borrowers really liquidated in each period. The reserve and the upfront repay hold {pct(backtest.periods[0]?.reserve.share ?? 0)} of debt in USDC; repaying from collateral holds none.</p>
        <BacktestChart backtest={backtest} />
      </div>
      <Findings backtest={backtest} />
      {money && <BacktestMoney backtest={backtest} />}
      <BacktestCaveats backtest={backtest} />
    </div>
  );
}

/** Why liquidated positions were missed, at the tighter bound. */
export function BacktestMisses({ backtest }: { backtest: CollateralFigures }) {
  const names = [...new Set(backtest.periods.flatMap((period) => first(period).misses.map((miss) => miss.reason)))];
  const nameOf = (reason: string) => backtest.periods.flatMap((period) => first(period).misses).find((miss) => miss.reason === reason)?.name ?? reason;
  return (
    <div className="scroll" tabIndex={0} role="region" aria-label="Why liquidated positions were missed">
      <table className="bt-money">
        <thead>
          <tr>
            <th scope="col">Missed because, {boundName(backtest.bounds[0] as number)}</th>
            {backtest.periods.map((period) => (
              <th key={period.key} scope="col">
                {period.calm ? "Calm month" : "Crash"}
                <small>{period.range}</small>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {names.map((reason) => (
            <tr key={reason}>
              <th scope="row">{nameOf(reason)}</th>
              {backtest.periods.map((period) => (
                <td key={period.key}>{integer(first(period).misses.find((miss) => miss.reason === reason)?.count ?? 0)}</td>
              ))}
            </tr>
          ))}
          <tr>
            <th scope="row">All missed, of those liquidated</th>
            {backtest.periods.map((period) => (
              <td key={period.key} className="strong">
                {integer(period.liquidated - first(period).saved)} of {integer(period.liquidated)}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** Net by size of debt at arming. */
export function BacktestSizes({ backtest }: { backtest: CollateralFigures }) {
  const threshold = backtest.sizes[0]?.threshold ?? 10_000;
  return (
    <div className="scroll" tabIndex={0} role="region" aria-label="Net by size of debt">
      <table className="bt-money">
        <thead>
          <tr>
            <th scope="col">Net by debt at arming, {backtest.bounds.map((bps) => `${bps / 100}%`).join(" / ")}</th>
            {backtest.periods.map((period) => (
              <th key={period.key} scope="col">
                {period.calm ? "Calm month" : "Crash"}
                <small>{period.range}</small>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(
            [
              [`Under $${integer(threshold / 1000)}k`, (period: PeriodFigures, bps: number) => backtest.sizes.find((row) => row.period === period.key && row.bps === bps)?.smallNet ?? 0],
              [`$${integer(threshold / 1000)}k and up`, (period: PeriodFigures, bps: number) => backtest.sizes.find((row) => row.period === period.key && row.bps === bps)?.largeNet ?? 0],
            ] as const
          ).map(([label, pick]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              {backtest.periods.map((period) => (
                <td key={period.key}>{backtest.bounds.map((bps) => signedUsdShort(pick(period, bps))).join(" / ")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The second mode's backtest, by reserve size, over liquidated positions only. */
export function ReserveBacktest({ backtest }: { backtest: BacktestFigures }) {
  const rows: Array<[string, "levee" | "upfront" | "collateral"]> = [
    ["Repay from a reserve", "levee"],
    ["Same USDC repaid upfront, no keeper", "upfront"],
    ["Same USDC held as collateral, no keeper", "collateral"],
  ];
  return (
    <>
      <p className="prose">
        The earlier backtest replayed the {integer(backtest.positions)} positions on {joined(backtest.chains)} that were really liquidated in {joined(backtest.windows)}, with a USDC reserve held for each.{" "}
        {backtest.upfrontNeverWorse ? "Repaying the same USDC upfront, with no keeper, saved at least as many at every reserve size, and costs nothing to hold, so it protects one position as well as a reserve. That is why repaying from collateral, which needs no cash, is the main mode, and the reserve is the second." : "Repaying the same USDC upfront did as well at most reserve sizes."}
      </p>
      <div className="scroll" tabIndex={0} role="region" aria-label="Reserve backtest by reserve size">
        <table className="nums">
          <caption className="vh">Share of liquidated positions that survived, by reserve size</caption>
          <thead>
            <tr>
              <th scope="col">Reserve, share of debt</th>
              {backtest.rows.map((row) => (
                <th key={row.share} scope="col">
                  {pct(row.share)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, key]) => (
              <tr key={key}>
                <th scope="row">{label}</th>
                {backtest.rows.map((row) => (
                  <td key={row.share} className={key === "upfront" ? "strong" : undefined}>
                    {countShare(row[key], row.positions)}%
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note-line">
        Saved means the position outlived the window. {integer(backtest.armedBelow)} of the {integer(backtest.positions)} were already below the trigger, so their repay was an upfront repay. Method and every table: backtest/results/summary.md and portfolio.md.
      </p>
    </>
  );
}

/** The home page's backtest section. */
export function BacktestSection() {
  const backtest = PROOF.backtest;
  if (!backtest) return null;
  return (
    <section className="s s-tint" id="backtest" aria-labelledby="backtest-h">
      <div className="sh">
        <h2 className="big" id="backtest-h">
          Backtest over {countWord(crashes(backtest).length).toLowerCase()} crashes and a calm month
        </h2>
        <p>{backtestIntro(backtest)}</p>
      </div>
      <BacktestBody backtest={backtest} money={false} />
      <p className="note-line">
        Every figure by period, the misses, the split by size and the reserve mode’s own backtest are on <Link href="/proof#backtest">the proof page</Link>.
      </p>
    </section>
  );
}
