import type { LatencyRow } from "@/lib/evidence.ts";
import { seconds } from "@/lib/format.ts";

const time = (milliseconds: number | null) => (milliseconds === null ? "not recorded" : seconds(milliseconds));

/** Plain names for the four hops, by the line each one ends on. */
const NAMES: Record<string, { label: string; where: string }> = {
  near: { label: "Detection to the rescue call on NEAR", where: "Keeper and NEAR" },
  mpc: { label: "Rescue call to signature", where: "MPC network" },
  send: { label: "Signature to the repay sent", where: "Keeper" },
  evm: { label: "Sent to included", where: "Lending chain" },
  overall: { label: "Detection to inclusion", where: "All of it" },
};

function Row({ row, strong = false }: { row: LatencyRow; strong?: boolean }) {
  const name = NAMES[row.id] ?? { label: row.label, where: row.where };
  return (
    <tr>
      <th scope="row">
        {name.label}
        <small>{name.where}</small>
      </th>
      <td className={strong ? "strong" : undefined}>{time(row.p50Ms)}</td>
      <td>{time(row.p95Ms)}</td>
      <td>{time(row.slowestMs)}</td>
      <td>{row.samples}</td>
    </tr>
  );
}

/** Every hop of a live run, worked out from the run records at build time. */
export function MeasuredTable({ hops, overall }: { hops: LatencyRow[]; overall: LatencyRow }) {
  return (
    <div className="scroll" tabIndex={0} role="region" aria-label="Time per hop">
      <table>
        <thead>
          <tr>
            <th scope="col">Hop</th>
            <th scope="col">p50</th>
            <th scope="col">p95</th>
            <th scope="col">Slowest</th>
            <th scope="col">Runs</th>
          </tr>
        </thead>
        <tbody>
          {hops.map((hop) => (
            <Row key={hop.id} row={hop} />
          ))}
          <Row row={overall} strong />
        </tbody>
      </table>
    </div>
  );
}
