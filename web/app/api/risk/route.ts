import { NextResponse, type NextRequest } from "next/server";
import { ADDRESS_ERRORS, parseAddress } from "@/lib/address.ts";
import { clientKey } from "@/lib/limit.ts";
import { MAX_TARGET, MIN_TARGET, parseTarget } from "@/lib/math.ts";
import { READS_PER_MINUTE, allowRead } from "@/lib/rate-limit.ts";
import { FRESH_SECONDS, getRiskReport } from "@/lib/risk.ts";
import { SCHEMA } from "@/lib/types.ts";

export const dynamic = "force-dynamic";

const CORS = { "Access-Control-Allow-Origin": "*" };

function refuse(code: string, message: string) {
  return NextResponse.json({ schema: SCHEMA, error: { code, message } }, { status: 400, headers: { ...CORS, "Cache-Control": "no-store" } });
}

function limited() {
  return NextResponse.json(
    { schema: SCHEMA, error: { code: "rate_limited", message: `This connection is limited to ${READS_PER_MINUTE} reads a minute. Try again shortly.` } },
    { status: 429, headers: { ...CORS, "Cache-Control": "no-store", "Retry-After": "60" } },
  );
}

/** The colo's cache on a Worker, shared across isolates. Elsewhere there is none. */
const edgeCache = () => (globalThis as { caches?: { default?: Cache } }).caches?.default;

export async function GET(request: NextRequest) {
  const parsed = parseAddress(request.nextUrl.searchParams.get("address") ?? "");
  if (!parsed.ok) return refuse("invalid_address", ADDRESS_ERRORS[parsed.error]);

  const target = parseTarget(request.nextUrl.searchParams.get("target"));
  if (target === null) return refuse("invalid_target", `Target must be a number from ${MIN_TARGET} to ${MAX_TARGET}.`);

  // Keyed on the parsed values, so capitalisation or argument order cannot split the cache. A hit costs no upstream call.
  const key = new Request(`${request.nextUrl.origin}/api/risk?address=${parsed.address}&target=${target}`);
  const cache = edgeCache();
  const hit = await cache?.match(key);
  if (hit) return hit;

  if (!(await allowRead(clientKey(request.headers)))) return limited();

  const report = await getRiskReport(parsed.address, target);
  const fresh = FRESH_SECONDS[report.status];
  const response = NextResponse.json(report, {
    // A report with no figures at all is an outage, not a result. The body has the same shape.
    status: report.status === "unavailable" ? 503 : 200,
    headers: { ...CORS, "Cache-Control": fresh ? `public, max-age=${fresh}` : "no-store" },
  });
  if (fresh) await cache?.put(key, response.clone());
  return response;
}
