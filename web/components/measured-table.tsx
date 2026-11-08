import { Fragment } from "react";
import type { LatencyRow } from "@/lib/evidence.ts";
import { seconds } from "@/lib/format.ts";
import type { ModeFigures } from "@/lib/proof.ts";

const time = (milliseconds: number | null) => (milliseconds === null ? "not recorded" : seconds(milliseconds));

/** Plain names for the four hops, by the line each one ends on. */
const NAMES: Record<string, { label: string; where: string }> = {
  near: { label: "Detection to the rescue call on NEAR", where: "Keeper and NEAR" },
  mpc: { label: "Rescue call to signature", where: "MPC network" },
  send: { label: "Signature to sent", where: "Keeper" },
  evm: { label: "Sent to included", where: "Lending chain" },
  overall: { label: "Detection to inclusion", where: "All of it" },
};

const HEADS: Record<ModeFigures["mode"], string> = { collateral: "From collateral", reserve: "From a reserve" };

/** Every hop of a live run, median and p95, one pair of columns per mode, worked out from the run records at build time. */
export function MeasuredTable({ modes }: { modes: ModeFigures[] }) {
  const shown = modes.filter((mode) => mode.timing.overall.samples > 0);
  const ids = [...(shown[0]?.timing.hops.map((row) => row.id) ?? []), "overall"];
  const rowOf = (mode: ModeFigures, id: string): LatencyRow | undefined => (id === "overall" ? mode.timing.overall : mode.timing.hops.find((row) => row.id === id));
  return (
    <div className="scroll" tabIndex={0} role="region" aria-label="Time per hop">
      <table className="hops-table">
        <thead>
          <tr>
            <th scope="col" rowSpan={2}>
              Hop
            </th>
            {shown.map((mode) => (
              <th key={mode.mode} scope="colgroup" colSpan={2} className="group">
                {HEADS[mode.mode]}, {mode.timing.overall.samples} runs
              </th>
            ))}
          </tr>
          <tr>
            {shown.map((mode) => (
              <Fragment key={mode.mode}>
                <th scope="col">Median</th>
                <th scope="col">p95</th>
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {ids.map((id) => {
            const name = NAMES[id] ?? { label: id, where: "" };
            const strong = id === "overall";
            return (
              <tr key={id}>
                <th scope="row">
                  {name.label}
                  <small>{name.where}</small>
                </th>
                {shown.map((mode) => {
                  const row = rowOf(mode, id);
                  return (
                    <Fragment key={mode.mode}>
                      <td className={strong ? "strong" : undefined}>{time(row?.p50Ms ?? null)}</td>
                      <td>{time(row?.p95Ms ?? null)}</td>
                    </Fragment>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
