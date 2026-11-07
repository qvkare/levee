/** The reading the home page opens with. It resolves on any outcome, and an example it falls back to is marked as one. */
import type { Address } from "viem";
import { HOME_ADDRESSES } from "./examples.ts";
import stored from "./fixtures/example-report.json" with { type: "json" };
import { fitsHome, type HomeReading } from "./home-reading-rules.ts";
import { getRiskReport } from "./risk.ts";
import type { RiskReport } from "./types.ts";

export const EXAMPLE_REPORT = stored as unknown as RiskReport;

export async function getHomeReading(): Promise<HomeReading> {
  for (const address of HOME_ADDRESSES) {
    const report = await getRiskReport(address as Address);
    if (fitsHome(report)) return { source: "built", report };
  }
  return { source: "example", report: EXAMPLE_REPORT };
}
