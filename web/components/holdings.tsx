import { CHAINS } from "@/lib/chains.ts";
import { amount, plainShare, ratio, usd } from "@/lib/format.ts";
import type { AavePosition, ReserveLine, RiskReport } from "@/lib/types.ts";

interface Line extends ReserveLine {
  id: string;
  position: string;
  role: string;
}

const linesOf = (position: string, { reserves }: AavePosition): Line[] => [
  ...(reserves?.collateral ?? []).map((line) => ({ ...line, id: `${position}:c:${line.asset}`, position, role: "Collateral" })),
  ...(reserves?.debt ?? []).map((line) => ({ ...line, id: `${position}:d:${line.asset}`, position, role: "Debt" })),
];

function termsOf(label: string, position: AavePosition): string {
  const parts = [`liquidation threshold ${plainShare(position.liquidationThreshold)}`, `LTV ${plainShare(position.ltv)}`];
  const bonus = position.reserves?.liquidationBonus;
  if (bonus != null) parts.push(`liquidation bonus ${plainShare(bonus)}`);
  const eMode = position.reserves?.eModeCategory;
  if (eMode) parts.push(`e-mode category ${eMode}`);
  return `${label}: ${parts.join(", ")}.`;
}

/** What sits behind the rows: each Aave asset, the terms, the Hyperliquid margin, and what a source said about itself. */
export function Holdings({ report, quiet = [] }: { report: RiskReport; quiet?: string[] }) {
  const markets = [report.aave.base, report.aave.arbitrum].filter((market) => market.position);
  const lines = markets.flatMap((market) => linesOf(`Aave on ${CHAINS[market.chain].label}`, market.position as AavePosition));
  const { pools, notes, positions } = report.hyperliquid;
  const uncovered = [...new Set(positions.filter((perp) => !perp.covered).map((perp) => perp.coverageNote))];
  const assumptionNotes = [...new Set(markets.flatMap((market) => market.position?.dropToLiquidation?.note ?? []))].filter((note) => !quiet.includes(note));
  if (lines.length === 0 && pools.length === 0 && notes.length === 0) return null;

  return (
    <>
      {lines.length > 0 && (
        <>
          <h3 className="sub">What each Aave position holds</h3>
          <div className="scroll">
            <table className="nums">
              <thead>
                <tr>
                  <th scope="col">Position</th>
                  <th scope="col">Role</th>
                  <th scope="col">Asset</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Value</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.id}>
                    <td>{line.position}</td>
                    <td>{line.role}</td>
                    <td>{line.symbol}</td>
                    <td>
                      {amount(line.amount)}
                    </td>
                    <td>
                      {usd(line.usd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {markets.map((market) => (
            <p key={market.chain} className="note-line">
              {termsOf(`Aave on ${CHAINS[market.chain].label}`, market.position as AavePosition)}
            </p>
          ))}
          {assumptionNotes.map((note) => (
            <p key={note} className="note-line">
              {note}
            </p>
          ))}
        </>
      )}
      {pools.length > 0 && (
        <>
          <h3 className="sub">Hyperliquid margin</h3>
          <div className="scroll">
            <table className="nums">
              <thead>
                <tr>
                  <th scope="col">Margin pool</th>
                  <th scope="col">Equity</th>
                  <th scope="col">Maintenance</th>
                  <th scope="col">Ratio, liquidates at 1.00</th>
                </tr>
              </thead>
              <tbody>
                {pools.map((pool) => (
                  <tr key={pool.id}>
                    <td>{pool.label}</td>
                    <td>
                      {usd(pool.equityUsd)}
                    </td>
                    <td>
                      {usd(pool.maintenanceUsd)}
                    </td>
                    <td>
                      {pool.marginRatio === null ? "none" : ratio(pool.marginRatio)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {[...notes, ...uncovered].map((note) => (
        <p key={note} className="note-line">
          {note}
        </p>
      ))}
    </>
  );
}
