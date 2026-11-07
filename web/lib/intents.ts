/**
 * Live NEAR Intents 1Click quotes for the route a reserve would take to a rescuer. Dry quotes
 * only: they return a price and a time estimate and move nothing.
 */
import { ttlCache } from "./cache.ts";

export const ONECLICK_QUOTE_URL = "https://1click.chaindefuser.com/v0/quote";

/** Asset ids from GET /v0/tokens. */
export const ROUTE_ASSETS = {
  base: { assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", decimals: 6, label: "USDC on Base" },
  arbitrum: { assetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", decimals: 6, label: "USDC on Arbitrum" },
  hyperliquid: { assetId: "1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054", decimals: 8, label: "USDC on Hyperliquid" },
} as const;

export type RouteEnd = keyof typeof ROUTE_ASSETS;

/** Levee's own rescuer for position 1. Quotes need a real address; nothing is sent to it. */
export const QUOTE_ADDRESS = "0xEA3ce7f3AeC39CE95D0fA32F867BA65EFF3b8971";

export const MIN_AMOUNT = 2;
export const MAX_AMOUNT = 100_000;

export interface RouteQuote {
  status: "ok" | "unavailable";
  from: RouteEnd;
  to: RouteEnd;
  amountIn: string | null;
  amountOut: string | null;
  timeEstimateSeconds: number | null;
  confidential: boolean;
  authenticated: boolean;
  quotedAt: string;
  reason: string | null;
}

export function isRouteEnd(value: string | null): value is RouteEnd {
  return value !== null && Object.hasOwn(ROUTE_ASSETS, value);
}

export function parseAmount(value: string | null): number | null {
  if (value === null || !/^\d+(\.\d{1,6})?$/.test(value)) return null;
  const amount = Number(value);
  return amount >= MIN_AMOUNT && amount <= MAX_AMOUNT ? amount : null;
}

/** Base units as a decimal string, without floating point error. */
export function toBaseUnits(amount: number, decimals: number): string {
  const [whole, fraction = ""] = amount.toFixed(6).split(".");
  const digits = `${whole}${fraction.padEnd(decimals, "0").slice(0, decimals)}`;
  return BigInt(digits).toString();
}

export function buildQuoteRequest(from: RouteEnd, to: RouteEnd, amount: number, confidential: boolean, now: Date) {
  const body: Record<string, unknown> = {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: ROUTE_ASSETS[from].assetId,
    destinationAsset: ROUTE_ASSETS[to].assetId,
    amount: toBaseUnits(amount, ROUTE_ASSETS[from].decimals),
    depositType: "ORIGIN_CHAIN",
    recipient: QUOTE_ADDRESS,
    recipientType: "DESTINATION_CHAIN",
    refundTo: QUOTE_ADDRESS,
    refundType: "ORIGIN_CHAIN",
    deadline: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
  };
  if (confidential) body.confidentiality = "basic";
  return body;
}

type Fetch = typeof fetch;

export async function quoteRoute(
  from: RouteEnd,
  to: RouteEnd,
  amount: number,
  options: { apiKey?: string; fetch?: Fetch; now?: () => Date } = {},
): Promise<RouteQuote> {
  const now = (options.now ?? (() => new Date()))();
  const apiKey = options.apiKey ?? "";
  const authenticated = apiKey.length > 0;
  // Confidential quotes need a partner key, so without one the quote is public.
  const confidential = authenticated;
  const base = { from, to, confidential, authenticated, quotedAt: now.toISOString() };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authenticated) headers["X-API-Key"] = apiKey;

  try {
    const response = await (options.fetch ?? fetch)(ONECLICK_QUOTE_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(buildQuoteRequest(from, to, amount, confidential, now)),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await response.json()) as { quote?: Record<string, unknown>; message?: string };
    if (!response.ok || !json.quote) {
      return { ...base, status: "unavailable", amountIn: null, amountOut: null, timeEstimateSeconds: null, reason: json.message ?? `HTTP ${response.status}` };
    }
    return {
      ...base,
      status: "ok",
      amountIn: String(json.quote.amountInFormatted),
      amountOut: String(json.quote.amountOutFormatted),
      timeEstimateSeconds: typeof json.quote.timeEstimate === "number" ? json.quote.timeEstimate : null,
      reason: null,
    };
  } catch (error) {
    return { ...base, status: "unavailable", amountIn: null, amountOut: null, timeEstimateSeconds: null, reason: error instanceof Error ? error.message : String(error) };
  }
}

const cache = ttlCache<RouteQuote>((quote) => (quote.status === "ok" ? 60_000 : 10_000), 32);

export function cachedQuoteRoute(from: RouteEnd, to: RouteEnd, amount: number): Promise<RouteQuote> {
  return cache.get(`${from}:${to}:${amount}`, () => quoteRoute(from, to, amount, { apiKey: process.env.INTENTS_PARTNER_KEY }));
}
