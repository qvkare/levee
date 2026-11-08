import { countShare as share, integer, joined } from "@/lib/format.ts";
import { PROOF, type BacktestFigures } from "@/lib/proof.ts";
import { BacktestChart } from "./backtest-chart.tsx";

const pct = (fraction: number) => `${Math.round(fraction * 100)}%`;

export function backtestIntro(backtest: BacktestFigures): string {
  return `Aave positions on ${joined(backtest.chains)} that were really liquidated in ${joined(backtest.windows)}, replayed with trigger ${backtest.trigger.toFixed(2)}, target ${backtest.target.toFixed(2)} and a ${backtest.delaySec} second delay. A simulation: it assumes the keeper, RPCs, NEAR and MPC all worked through the worst minutes.`;
}

function UpfrontNote({ backtest }: { backtest: BacktestFigures }) {
  const better = backtest.rows.filter((row) => row.upfront >= row.levee).length;
  return (
    <div className="note note-dark">
      {backtest.upfrontNeverWorse ? (
        <p>
          <b>An upfront repay did as well.</b> Repaying the same USDC at the start, with no keeper, saved as many positions as Levee or more at every reserve size.
        </p>
      ) : (
        <p>
          <b>
            An upfront repay did as well at {better} of {backtest.rows.length} reserve sizes.
          </b>{" "}
          That is the same USDC repaid at the start, with no keeper.
        </p>
      )}
      <p>The numbers that separate Levee from an upfront repay are being re-measured.</p>
    </div>
  );
}

function CollateralNote({ backtest }: { backtest: BacktestFigures }) {
  const beats = backtest.collateralBeatsBoth;
  return (
    <div className="note note-plain">
      <p>
        {beats.length > 0 ? `At a ${joined(beats.map(pct))} reserve, plain USDC collateral beat both. ` : "Plain USDC collateral did worse than both at every reserve size. "}
        Reserve size decides most of the result, so no single point on this chart is the answer.
      </p>
      <p>Saved means the position outlived the window. Only liquidated positions are in the sample, so false alarms are not measured.</p>
    </div>
  );
}

export function Remeasured() {
  return <p className="re">Being re-measured</p>;
}

/** The chart, its key and the two notes that keep it honest. */
export function BacktestBody({ backtest }: { backtest: BacktestFigures }) {
  return (
    <div className="bt-wrap">
      <div className="card card-white">
        <h3>Share of positions that survived, by reserve size</h3>
        <p className="cap">Reserve as a share of debt, along the bottom.</p>
        <ul className="keyrow" aria-label="Key">
          <li>
            <i className="key-ink" aria-hidden="true" />
            Levee
          </li>
          <li>
            <i className="key-amber" aria-hidden="true" />
            Same USDC repaid upfront
          </li>
          <li>
            <i className="key-grey" aria-hidden="true" />
            Same USDC held as collateral
          </li>
        </ul>
        <BacktestChart rows={backtest.rows} />
      </div>
      <div className="bt-side">
        <UpfrontNote backtest={backtest} />
        <CollateralNote backtest={backtest} />
      </div>
    </div>
  );
}

/** All three rows at every reserve size, as a table. */
export function BacktestTable({ backtest }: { backtest: BacktestFigures }) {
  const rows: Array<[string, "levee" | "upfront" | "collateral"]> = [
    ["Levee saved", "levee"],
    ["Same USDC repaid upfront, no keeper", "upfront"],
    ["Same USDC held as collateral, no keeper", "collateral"],
  ];
  return (
    <div className="scroll">
      <table className="nums">
        <caption className="vh">Share of positions that survived, by reserve size</caption>
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
                <td key={row.share} className={key === "levee" ? "strong" : undefined}>
                  {share(row[key], row.positions)}%
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The home page's backtest section. */
export function BacktestSection() {
  const backtest = PROOF.backtest;
  if (!backtest) return null;
  return (
    <section className="s s-tint" id="backtest" aria-labelledby="backtest-h">
      <Remeasured />
      <div className="sh">
        <h2 className="big" id="backtest-h">
          Backtest on {integer(backtest.positions)} liquidated positions
        </h2>
        <p>{backtestIntro(backtest)}</p>
      </div>
      <BacktestBody backtest={backtest} />
    </section>
  );
}
