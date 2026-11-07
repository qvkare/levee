import type { LatencyRow } from "@/lib/evidence.ts";
import { seconds } from "@/lib/format.ts";
import { Num } from "./num.tsx";

const time = (milliseconds: number | null) => (milliseconds === null ? "not recorded" : seconds(milliseconds));

function Row({ row, strong = false }: { row: LatencyRow; strong?: boolean }) {
  return (
    <tr>
      <td>{row.label}</td>
      <td>{row.where}</td>
      <td className={strong ? "strong" : undefined}>
        <Num>{time(row.p50Ms)}</Num>
      </td>
      <td>
        <Num>{time(row.p95Ms)}</Num>
      </td>
      <td>
        <Num>{time(row.slowestMs)}</Num>
      </td>
      <td>{row.samples}</td>
    </tr>
  );
}

/** Every hop of a live run, computed from the run records at build time. */
export function MeasuredTable({ hops, overall }: { hops: LatencyRow[]; overall: LatencyRow }) {
  return (
    <div className="scroll">
      <table className="nums">
        <thead>
          <tr>
            <th scope="col">Hop</th>
            <th scope="col">Where</th>
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
