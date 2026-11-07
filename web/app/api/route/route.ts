import { NextResponse, type NextRequest } from "next/server";
import { MAX_AMOUNT, MIN_AMOUNT, cachedQuoteRoute, isRouteEnd, parseAmount, ROUTE_ASSETS } from "@/lib/intents.ts";

export const dynamic = "force-dynamic";

const CORS = { "Access-Control-Allow-Origin": "*" };
const ENDS = Object.keys(ROUTE_ASSETS).join(", ");

function refuse(code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status: 400, headers: { ...CORS, "Cache-Control": "no-store" } });
}

/** A live NEAR Intents dry quote for moving USDC between two ends. Nothing moves. */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const from = params.get("from") ?? "arbitrum";
  const to = params.get("to") ?? "base";
  if (!isRouteEnd(from) || !isRouteEnd(to) || from === to) return refuse("invalid_route", `from and to must differ, from: ${ENDS}`);
  const amount = parseAmount(params.get("amount") ?? "20");
  if (amount === null) return refuse("invalid_amount", `amount must be ${MIN_AMOUNT} to ${MAX_AMOUNT} USDC`);

  const quote = await cachedQuoteRoute(from, to, amount);
  return NextResponse.json(quote, {
    status: quote.status === "ok" ? 200 : 503,
    headers: { ...CORS, "Cache-Control": quote.status === "ok" ? "public, max-age=60" : "no-store" },
  });
}
