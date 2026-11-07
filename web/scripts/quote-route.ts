/** Prints live dry quotes for the reserve routes. Uses INTENTS_PARTNER_KEY when set. */
import { quoteRoute, type RouteEnd } from "../lib/intents.ts";

const routes: Array<[RouteEnd, RouteEnd]> = [["arbitrum", "base"], ["base", "arbitrum"], ["base", "hyperliquid"]];
for (const [from, to] of routes) {
  const q = await quoteRoute(from, to, 20, { apiKey: process.env.INTENTS_PARTNER_KEY });
  const mode = q.confidential ? "confidential" : "public";
  console.log(q.status === "ok"
    ? `${from} -> ${to}: 20 USDC in, ${q.amountOut} out, about ${q.timeEstimateSeconds} s, ${mode}`
    : `${from} -> ${to}: unavailable, ${q.reason}`);
}
