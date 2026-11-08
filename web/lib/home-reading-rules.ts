/** What may stand on the home page. Pure, so the browser can apply it to a live read as well. */
import type { RiskReport } from "./types.ts";
import { buildLine } from "./line.ts";

/** built: read when this page was built. example: no read could be used. */
export interface HomeReading {
  source: "built" | "example";
  report: RiskReport;
}

/** A third party's address is here only to show the tool. The last-5% state is for an address someone asked about. */
export function fitsHome(report: RiskReport): boolean {
  const line = buildLine(report);
  return report.status !== "unavailable" && line.placed.length > 0 && line.crisis === null;
}
