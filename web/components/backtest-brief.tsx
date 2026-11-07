import Link from "next/link";
import { BRIEF } from "@/lib/brief.ts";
import { integer, percent, plainShare, seconds } from "@/lib/format.ts";
import { Num } from "./num.tsx";

/** The whole row of reserve sizes, because one cell alone misleads. All of it is read at build time. */
export function BacktestBrief() {
  const { backtest, signing } = BRIEF;
  if (!backtest) return null;
  return (
    <div>
      <h2>Reserve size decides the backtest.</h2>
      <div className="scroll">
        <table className="nums">
          <thead>
            <tr>
              <th scope="col">Reserve, share of debt</th>
              {backtest.rows.map((row) => (
                <th key={row.reserveShare} scope="col">
                  {plainShare(row.reserveShare)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Levee saved</td>
              {backtest.rows.map((row) => (
                <td key={row.reserveShare}>
                  <Num>{percent(row.leveeShare)}</Num>
                </td>
              ))}
            </tr>
            <tr>
              <td>Same USDC as collateral</td>
              {backtest.rows.map((row) => (
                <td key={row.reserveShare}>
                  <Num>{percent(row.collateralShare)}</Num>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        {integer(backtest.positions)} positions liquidated on Aave, trigger {backtest.trigger.toFixed(2)}, target {backtest.target.toFixed(2)}, {backtest.delaySec} s delay. A simulation, not rescues that happened.
        {signing && signing.p50Ms !== null && signing.slowestMs !== null && (
          <>
            {" "}
            Signatures on NEAR testnet: {signing.signed} of {signing.runs}, median {seconds(signing.p50Ms)}, slowest {seconds(signing.slowestMs)}, nothing broadcast.
          </>
        )}{" "}
        <Link href="/proof">The misses and the limits</Link>.
      </p>
    </div>
  );
}
