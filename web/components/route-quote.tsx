"use client";

import { useEffect, useId, useState } from "react";
import { clock } from "@/lib/format.ts";

type End = "base" | "arbitrum" | "hyperliquid";

/** The shape /api/route answers with. Checked field by field, because a failed route must not print as a figure. */
interface RouteQuote {
  status: "ok" | "unavailable";
  amountOut: string | null;
  timeEstimateSeconds: number | null;
  confidential: boolean;
  quotedAt: string;
}

type State = { kind: "asking" } | { kind: "quoted"; quote: RouteQuote } | { kind: "unavailable" };

const NAMES: Record<End, string> = { base: "Base", arbitrum: "Arbitrum", hyperliquid: "Hyperliquid" };

function usable(value: unknown): value is RouteQuote {
  if (typeof value !== "object" || value === null) return false;
  const quote = value as Record<string, unknown>;
  return quote.status === "ok" && typeof quote.amountOut === "string" && typeof quote.confidential === "boolean" && typeof quote.quotedAt === "string" && (quote.timeEstimateSeconds === null || typeof quote.timeEstimateSeconds === "number");
}

/**
 * A live dry quote for the route a reserve would take to the rescuer, asked from the browser. It
 * moves nothing. A failed or missing route says so in words.
 */
export function RouteQuotePanel({ from = "arbitrum", to = "base", amount = 20 }: { from?: End; to?: End; amount?: number }) {
  const id = useId();
  const [state, setState] = useState<State>({ kind: "asking" });

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/route?from=${from}&to=${to}&amount=${amount}`, { signal: controller.signal })
      .then(async (response) => {
        const body: unknown = await response.json().catch(() => null);
        setState(response.ok && usable(body) ? { kind: "quoted", quote: body } : { kind: "unavailable" });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ kind: "unavailable" });
      });
    return () => controller.abort();
  }, [from, to, amount]);

  const route = `${amount} USDC from ${NAMES[from]} to ${NAMES[to]}`;
  return (
    <section className="quote" aria-labelledby={`${id}-title`} aria-live="polite" aria-busy={state.kind === "asking"}>
      <p id={`${id}-title`}>
        <b>Dry quote.</b> {route}, asked of NEAR Intents 1Click from this page. Nothing moves, and the reserve layer is not built yet.
      </p>
      {state.kind === "asking" && (
        <p className="quote-state">
          Asking for a quote.
          <noscript> The quote needs scripts. The same figures are at /api/route.</noscript>
        </p>
      )}
      {state.kind === "unavailable" && <p className="quote-state">The route is unavailable at the moment, so there is no quote to show.</p>}
      {state.kind === "quoted" && (
        <dl>
          <div>
            <dt>Arrives</dt>
            <dd>{state.quote.amountOut} USDC</dd>
          </div>
          <div>
            <dt>Time estimate</dt>
            <dd>{state.quote.timeEstimateSeconds === null ? "none given" : `${state.quote.timeEstimateSeconds} s`}</dd>
          </div>
          <div>
            <dt>Confidential</dt>
            <dd>{state.quote.confidential ? "Yes" : "No"}</dd>
          </div>
          <div>
            <dt>Quoted at</dt>
            <dd>{clock(state.quote.quotedAt)}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}
