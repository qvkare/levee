import { CHAINS } from "@/lib/chains.ts";
import { STAGE_NAMES, amount, integer, percent, share, stageValue, usd, utcTime } from "@/lib/format.ts";
import type { AaveMarket, AavePosition, Failure, RepayFigure, ReserveLine } from "@/lib/types.ts";
import { OutOfService } from "./out-of-service.tsx";
import { StackTable, type Column } from "./stack-table.tsx";

type AssetRow = ReserveLine & { role: string };

function leveeNote(repay: RepayFigure): string | null {
  if (repay.usdcDebtUsd === null) return null;
  if (repay.usdcDebtUsd === 0) return "Levee repays USDC debt only. This position has no USDC debt, so Levee could not repay it.";
  if (repay.usd === 0) return `Levee repays USDC debt only. USDC debt here is ${usd(repay.usdcDebtUsd)}.`;
  if (repay.usdcCovers) return `Levee repays USDC debt only. USDC debt here is ${usd(repay.usdcDebtUsd)}, which covers this repay.`;
  const reach = repay.healthAfterAllUsdc === null ? "" : `, and repaying all of it reaches ${stageValue(repay.healthAfterAllUsdc)}`;
  return `Levee repays USDC debt only. USDC debt here is ${usd(repay.usdcDebtUsd)}${reach}.`;
}

const ASSET_COLUMNS: Column<AssetRow>[] = [
  { label: "Role", cell: (row) => row.role },
  { label: "Asset", cell: (row) => row.symbol },
  { label: "Amount", numeric: true, cell: (row) => amount(row.amount) },
  { label: "Value", numeric: true, cell: (row) => usd(row.usd) },
];

function Figures({ position }: { position: AavePosition }) {
  const { healthFactor, stage, debtUsd, collateralUsd, liquidationThreshold, dropToLiquidation, repay, reserves } = position;
  return (
    <div className="station-body">
      <table className="figures" aria-label="Position figures">
        <tbody>
          <tr>
            <th scope="row">Health factor</th>
            <td className={stage === "flood" ? "flood-text" : undefined}>{healthFactor === null ? "No debt" : stageValue(healthFactor)}</td>
          </tr>
          <tr>
            <th scope="row">Stage</th>
            <td className={stage === "flood" ? "flood-text" : undefined}>{STAGE_NAMES[stage]}</td>
          </tr>
          <tr>
            <th scope="row">Debt</th>
            <td>{usd(debtUsd)}</td>
          </tr>
          <tr>
            <th scope="row">Collateral</th>
            <td>{usd(collateralUsd)}</td>
          </tr>
          <tr>
            <th scope="row">Liquidation threshold</th>
            <td>{share(liquidationThreshold)}</td>
          </tr>
          {dropToLiquidation && (
            <tr>
              <th scope="row">Approximate fall to liquidation</th>
              <td>{percent(dropToLiquidation.fraction)}</td>
            </tr>
          )}
          {reserves?.liquidationBonus != null && (
            <tr>
              <th scope="row">Liquidation bonus</th>
              <td>{share(reserves.liquidationBonus)}</td>
            </tr>
          )}
          {repay && (
            <tr>
              <th scope="row">Repay to reach {repay.target.toFixed(2)}</th>
              <td>{repay.usd > 0 ? usd(repay.usd) : "None needed"}</td>
            </tr>
          )}
        </tbody>
      </table>

      {reserves ? (
        <StackTable
          caption={`Assets at Aave oracle prices${reserves.eModeCategory > 0 ? `, e-mode ${reserves.eModeCategory}` : ""}`}
          columns={ASSET_COLUMNS}
          rows={[...reserves.collateral.map((line) => ({ ...line, role: "Collateral" })), ...reserves.debt.map((line) => ({ ...line, role: "Debt" }))]}
          rowKey={(row) => `${row.role}-${row.asset}`}
          phone="table"
        />
      ) : (
        <p className="muted small">Per-asset detail was not read. The totals here come from getUserAccountData and are unaffected.</p>
      )}

      <div className="station-notes">
        {dropToLiquidation && (
          <p>
            The fall is an approximation: <code>{dropToLiquidation.formula}</code>. {dropToLiquidation.assumption}
          </p>
        )}
        {dropToLiquidation?.note && <p className="medium">{dropToLiquidation.note}</p>}
        {repay && leveeNote(repay) && <p>{leveeNote(repay)}</p>}
      </div>
    </div>
  );
}

export function AaveStation({ market, failure }: { market: AaveMarket; failure?: Failure }) {
  const chain = CHAINS[market.chain];
  const readAt = market.blockTimestamp ? `, ${utcTime(market.blockTimestamp * 1000)}` : "";
  return (
    <section className="station" aria-labelledby={`station-${market.chain}`}>
      <h2 id={`station-${market.chain}`}>Aave on {chain.label}</h2>
      {market.status === "unavailable" ? (
        <OutOfService message={failure?.message ?? `${chain.label} figures are missing, not zero.`} />
      ) : (
        <>
          <p className="station-meta">
            Read at block {integer(market.blockNumber ?? 0)}
            {readAt}.
          </p>
          {market.position ? <Figures position={market.position} /> : <p className="station-meta">No position on this pool.</p>}
        </>
      )}
    </section>
  );
}
