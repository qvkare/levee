import { NextResponse } from "next/server";
import { getDrillTerms } from "@/lib/drill-terms.ts";

export const dynamic = "force-dynamic";

/** The home page is prerendered, so the drill asks here for a fresh reading on load. */
export async function GET() {
  const terms = await getDrillTerms("live");
  return NextResponse.json(terms, { headers: { "Cache-Control": terms.source === "example" ? "no-store" : "public, max-age=30" } });
}
