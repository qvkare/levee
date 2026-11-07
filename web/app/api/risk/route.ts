import { NextResponse, type NextRequest } from "next/server";
import { ADDRESS_ERRORS, parseAddress } from "@/lib/address.ts";
import { MAX_TARGET, MIN_TARGET, parseTarget } from "@/lib/math.ts";
import { FRESH_SECONDS, getRiskReport } from "@/lib/risk.ts";
import { SCHEMA } from "@/lib/types.ts";

export const dynamic = "force-dynamic";

const CORS = { "Access-Control-Allow-Origin": "*" };

function refuse(code: string, message: string) {
  return NextResponse.json({ schema: SCHEMA, error: { code, message } }, { status: 400, headers: { ...CORS, "Cache-Control": "no-store" } });
}

export async function GET(request: NextRequest) {
  const parsed = parseAddress(request.nextUrl.searchParams.get("address") ?? "");
  if (!parsed.ok) return refuse("invalid_address", ADDRESS_ERRORS[parsed.error]);

  const target = parseTarget(request.nextUrl.searchParams.get("target"));
  if (target === null) return refuse("invalid_target", `Target must be a number from ${MIN_TARGET} to ${MAX_TARGET}.`);

  const report = await getRiskReport(parsed.address, target);
  const fresh = FRESH_SECONDS[report.status];
  return NextResponse.json(report, {
    // A report with no figures at all is an outage, not a result. The body has the same shape.
    status: report.status === "unavailable" ? 503 : 200,
    headers: { ...CORS, "Cache-Control": fresh ? `public, max-age=0, s-maxage=${fresh}, stale-while-revalidate=${fresh}` : "no-store" },
  });
}
