import assert from "node:assert/strict";
import { test } from "node:test";
import { buildQuoteRequest, parseAmount, quoteRoute, toBaseUnits } from "./intents.ts";

const NOW = new Date("2026-11-07T20:00:00.000Z");

test("amounts convert to base units exactly", () => {
  assert.equal(toBaseUnits(20, 6), "20000000");
  assert.equal(toBaseUnits(20, 8), "2000000000");
  assert.equal(toBaseUnits(0.1, 6), "100000");
});

test("amounts outside the range are refused", () => {
  assert.equal(parseAmount("1"), null);
  assert.equal(parseAmount("1e3"), null);
  assert.equal(parseAmount("20"), 20);
  assert.equal(parseAmount("100001"), null);
});

test("a quote is always dry, and confidential only when asked", () => {
  const publicBody = buildQuoteRequest("arbitrum", "base", 20, false, NOW);
  assert.equal(publicBody.dry, true);
  assert.equal(publicBody.confidentiality, undefined);
  assert.equal(buildQuoteRequest("arbitrum", "base", 20, true, NOW).confidentiality, "basic");
});

test("the key goes in X-API-Key and makes the quote confidential", async () => {
  let seen: RequestInit | undefined;
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    seen = init;
    return new Response(JSON.stringify({ quote: { amountInFormatted: "20.0", amountOutFormatted: "19.99", timeEstimate: 34 } }), { status: 201 });
  }) as unknown as typeof fetch;
  const quote = await quoteRoute("arbitrum", "base", 20, { apiKey: "k", fetch: fakeFetch, now: () => NOW });
  assert.equal((seen?.headers as Record<string, string>)["X-API-Key"], "k");
  assert.equal(JSON.parse(String(seen?.body)).confidentiality, "basic");
  assert.deepEqual([quote.status, quote.amountOut, quote.timeEstimateSeconds, quote.confidential], ["ok", "19.99", 34, true]);
});

test("a refusal is reported, not thrown", async () => {
  const fakeFetch = (async () => new Response(JSON.stringify({ message: "nope" }), { status: 401 })) as unknown as typeof fetch;
  const quote = await quoteRoute("base", "hyperliquid", 20, { fetch: fakeFetch, now: () => NOW });
  assert.deepEqual([quote.status, quote.reason, quote.confidential], ["unavailable", "nope", false]);
});
