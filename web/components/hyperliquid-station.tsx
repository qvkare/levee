import { amount, percent, price, stageValue, usd, utcTime } from "@/lib/format.ts";
import type { Failure, HyperliquidAccount, HyperliquidMode, MarginPool, PerpPosition } from "@/lib/types.ts";
import { OutOfService } from "./out-of-service.tsx";
import { StackTable, type Column } from "./stack-table.tsx";

const MAX_ROWS = 30;

const MODE_NAMES: Record<HyperliquidMode, string> = {
  standard: "Standard",
  unified: "Unified",
  portfolio: "Portfolio margin",
  "dex-abstraction": "DEX abstraction",
  unknown: "Not read",
};

const POOL_COLUMNS: Column<MarginPool>[] = [
  { label: "Pool", cell: (pool) => pool.label },
  { label: "Equity", numeric: true, cell: (pool) => usd(pool.equityUsd) },
  { label: "Maintenance margin", numeric: true, cell: (pool) => usd(pool.maintenanceUsd) },
  {
    label: "Margin ratio",
    numeric: true,
    cell: (pool) => (pool.marginRatio === null ? "No margin used" : stageValue(pool.marginRatio)),
    emphasis: (pool) => pool.marginRatio !== null && pool.marginRatio < 1,
  },
];

const POSITION_COLUMNS: Column<PerpPosition>[] = [
  { label: "Market", cell: (row) => <span className="medium">{row.market}</span> },
  { label: "Side", cell: (row) => (row.side === "long" ? "Long" : "Short") },
  { label: "Margin", cell: (row) => `${row.margin === "cross" ? "Cross" : "Isolated"} ${row.leverage}x` },
  { label: "Size", numeric: true, cell: (row) => amount(row.size) },
  { label: "Notional", numeric: true, cell: (row) => usd(row.notionalUsd) },
  { label: "Mark", numeric: true, cell: (row) => price(row.markPrice) },
  { label: "Liquidation", numeric: true, cell: (row) => (row.liquidationPrice === null ? "None reported" : price(row.liquidationPrice)) },
  {
    label: "Distance",
    numeric: true,
    cell: (row) => (row.distance === null ? "None" : percent(Math.max(0, row.distance))),
    emphasis: (row) => row.distance !== null && row.distance <= 0,
  },
  { label: "Levee", cell: (row) => (row.covered ? "In reach" : "Not covered") },
];

function Positions({ positions }: { positions: PerpPosition[] }) {
  const reasons = [...new Set(positions.filter((position) => !position.covered).map((position) => position.coverageNote))];
  return (
    <>
      <StackTable
        caption="Positions, nearest to liquidation first"
        columns={POSITION_COLUMNS}
        rows={positions.slice(0, MAX_ROWS)}
        rowKey={(row) => `${row.dex}-${row.market}`}
        phone="stack-3"
      />
      {positions.length > MAX_ROWS && <p className="small muted">The nearest {MAX_ROWS} of {positions.length} positions are shown. The JSON has all of them.</p>}
      {reasons.length > 0 && (
        <div className="station-notes">
          <p className="medium">Not covered:</p>
          <ul>
            {reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

export function HyperliquidStation({ account, failures }: { account: HyperliquidAccount; failures: Failure[] }) {
  return (
    <section className="station" aria-labelledby="station-hyperliquid">
      <h2 id="station-hyperliquid">Hyperliquid</h2>
      {account.status === "unavailable" ? (
        <OutOfService message={failures[0]?.message ?? "Hyperliquid figures are missing, not zero."} />
      ) : (
        <>
          <p className="station-meta">
            Account mode: {MODE_NAMES[account.mode]}
            {account.rawMode ? <> (<code>userAbstraction</code> returned <code>{account.rawMode}</code>)</> : null}
            {account.readAt ? `. Read ${utcTime(account.readAt)}.` : "."}
          </p>
          {account.positions.length === 0 ? (
            <p className="station-meta">No open positions.</p>
          ) : (
            <div className="hl-body">
              {account.pools.length > 0 && (
                <StackTable caption="Cross margin" columns={POOL_COLUMNS} rows={account.pools} rowKey={(pool) => pool.id} phone="table" />
              )}
              <Positions positions={account.positions} />
              <div className="station-notes">
                {account.notes.map((note) => (
                  <p key={note}>{note}</p>
                ))}
                <p>Margin ratio is equity divided by maintenance margin, and liquidation is at 1.00. Hyperliquid&apos;s own ratio is the inverse.</p>
                <p>Liquidation prices are as reported by Hyperliquid. On cross margin they move with funding and with other positions.</p>
                <p>&quot;In reach&quot; means a USDC top-up could reach that margin. Hyperliquid top-ups are a later Levee phase and are not live, so nothing here is protected.</p>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
