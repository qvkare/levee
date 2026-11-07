import { StackTable, type Column } from "./stack-table.tsx";

interface Band {
  stage: string;
  health: string;
  fall: string;
  flood?: boolean;
}

const BANDS: Band[] = [
  { stage: "Flood stage", health: "Below 1.00", fall: "None left. Liquidators can act now.", flood: true },
  { stage: "Action stage", health: "1.00 to 1.25", fall: "Under 20%" },
  { stage: "Watch", health: "1.25 to 1.50", fall: "20% to 33%" },
  { stage: "Normal", health: "1.50 and above", fall: "Over 33%" },
  { stage: "Dry", health: "No debt", fall: "Nothing to liquidate" },
];

const COLUMNS: Column<Band>[] = [
  { label: "Stage", cell: (band) => <span className="medium">{band.stage}</span>, emphasis: (band) => band.flood === true },
  { label: "Health factor", cell: (band) => band.health },
  { label: "Approximate fall to liquidation", cell: (band) => band.fall },
];

export function StageTable() {
  return <StackTable caption="Aave acts only at 1.00. The other bands are Levee's reading aid, not protocol rules." columns={COLUMNS} rows={BANDS} rowKey={(band) => band.stage} phone="table" />;
}
