<img src="public/levee-mark.svg" width="56" height="56" alt="Levee">

# Levee web

The Levee site and public risk tool. Paste any address and read how close it is to liquidation on Aave (Base and Arbitrum) and Hyperliquid. No wallet and no login.

It runs on Cloudflare Workers at `levee.qvkare.com`. Unaudited. It reads public data and holds no funds.

Spec: `../docs/SPEC.md`. Design direction: `DESIGN.md`. Read it before changing the interface.

## Run it

```bash
pnpm install
pnpm --filter web dev            # next dev
pnpm --filter web test           # unit tests, Node's own runner
pnpm --filter web typecheck
pnpm --filter web design-check   # bans from DESIGN.md
pnpm --filter web run preview    # OpenNext build, then the real Worker on local workerd, port 8787
pnpm --filter web run deploy     # build and deploy. Needs wrangler login
```

Use `run` for `deploy`: `pnpm deploy` without it is a pnpm command of its own.

## Pages

| Path | What it is |
|---|---|
| `/` | The wall for one public address, read live in the browser over a reading from the build. Then what Levee does with the first row, the backtest by reserve size, the position simulator and a few public addresses. Prerendered |
| `/a/[address]` | The wall for any address, then every figure in the same order, rendered in full on the server and read again in the browser every minute. `?target=1.75` sets the repay target. `?fall=11.1` marks the nearest Aave position's collateral down by that percentage and says it is a simulation |
| `/how` | A rescue in seven numbered steps, the trust table, what a stolen key cannot do, failure conditions, the measured hops, limits, how to read the wall, and the API shape. Prerendered |
| `/proof` | Every file in `../evidence/runs`, failures included, with explorer links and p50 and p95 per hop. The signing test, the fork rehearsal under its own label, and the backtest with its misses and limits. Prerendered |

The last 5% turns the page red: a reading or a simulation with a position inside it. The home page passes over a third party's address in that state, because the red page is for an address someone asked about.

## GET /api/risk

```
GET /api/risk?address=0x...&target=1.5
```

No key is needed. `target` is optional, from 1.05 to 3, and defaults to 1.5. CORS is open. The address is read in lowercase or EIP-55 form. Mixed case with a wrong checksum is refused, because it usually means a typo.

| Status | Meaning |
|---|---|
| 200 | `status` is `ok` or `partial` |
| 400 | `error.code` is `invalid_address` or `invalid_target`, and `error.message` says why |
| 429 | `error.code` is `rate_limited`. One client can make 30 reads a minute. `Retry-After` is 60 |
| 503 | No source answered. The body has the usual shape, with `status: "unavailable"` |

A null is a missing figure, not zero. `failures` says what is missing and why. `schema` changes only when a field is removed or changes meaning. `web/lib/types.ts` is the source of this shape.

| Field | Meaning |
|---|---|
| `schema` | `levee.risk.v2` |
| `address` | EIP-55 |
| `generatedAt` | ISO 8601, UTC |
| `status` | `ok`, `partial` or `unavailable` |
| `target` | Health factor used for the repay figures |
| `failures[]` | `source` (`aave.base`, `aave.arbitrum`, `hyperliquid`) and `message` |
| `nearest` | The reading closest to liquidation: `venue`, `label`, `standing`, `fall`. Null when nothing can be liquidated |
| `aave.base`, `aave.arbitrum` | One market each, below |
| `hyperliquid` | The account, below |

`standing` says where a position stands against liquidation: `none` (nothing can be liquidated), `open` (more than 5% away), `close` (inside the last 5%) or `liquidatable` (at or past the line). Version 2 replaces the `stage` field of version 1 with it, and drops the 20% and 33% bands.

Market:

| Field | Meaning |
|---|---|
| `status`, `chain`, `chainId`, `pool` | Which market, and whether it answered |
| `blockNumber`, `blockTimestamp` | Every figure in the market was read at this block |
| `position` | Null when the address has no position here |
| `position.healthFactor` | Null with no debt |
| `position.standing` | As above |
| `position.collateralUsd`, `debtUsd` | At Aave oracle prices |
| `position.liquidationThreshold`, `ltv` | 0 to 1, weighted, e-mode included |
| `position.dropToLiquidation` | `fraction`, `formula` (`1 - 1/HF`), `assumption`, `assumptionHolds` and `note`. An approximation. `assumptionHolds` is false when the position is not volatile collateral against stable debt |
| `position.repay` | `target`, `usd` (`D - (C * L) / T`), `usdcDebtUsd`, `usdcCovers`, `healthAfterAllUsdc`. Levee repays USDC debt only |
| `position.reserves` | `collateral[]`, `debt[]` (`asset`, `symbol`, `amount`, `usd`, `stable`), `eModeCategory`, `liquidationBonus`. Null if that read failed |
| `position.raw` | The exact `getUserAccountData` outputs as strings, to compare with a direct call |

Hyperliquid:

| Field | Meaning |
|---|---|
| `status`, `readAt` | Whether it answered, and the server time in milliseconds |
| `mode`, `rawMode` | `standard`, `unified`, `portfolio`, `dex-abstraction` or `unknown`, and the `userAbstraction` value as returned |
| `marginRatio` | Equity over maintenance margin, lowest pool. Liquidation is at 1.00. Null for portfolio accounts and with no cross position |
| `standing` | As above |
| `pools[]` | `id`, `label`, `equityUsd`, `maintenanceUsd`, `marginRatio` |
| `positions[]` | `market`, `dex`, `side`, `size`, `entryPrice`, `markPrice`, `notionalUsd`, `unrealizedPnlUsd`, `margin` (`cross` or `isolated`), `leverage`, `marginUsedUsd`, `liquidationPrice`, `distance`, `covered`, `coverageNote`. Nearest to liquidation first |
| `notes[]` | What to know about this account's mode |

`covered` says whether a USDC top-up could reach that margin. Top-ups are a later phase and are not live.

<!-- design-allow: names the version 1 values for API users who migrate -->
Version 1 had `stage` (`dry`, `normal`, `watch`, `action`, `flood`) where version 2 has `standing`. Nothing else changed shape.

## How it reads

- **Aave:** `getUserAccountData` on the Pool, and per-reserve detail from `UiPoolDataProvider`, the Pool's indexes and the Aave oracle, all at one pinned block through Multicall3. Addresses are from `bgd-labs/aave-address-book`, checked on chain against `ADDRESSES_PROVIDER()` and `getPriceOracle()`.
- **Hyperliquid:** `userAbstraction` picks the equity source. Unified accounts keep equity in `spotClearinghouseState`, so `clearinghouseState` alone is wrong for them: the liquidation price it implied was off by up to 219.8% on the accounts sampled. Every perp DEX is read. Portfolio margin needs borrow caps and oracle prices, so those accounts show positions and no ratio.
- **Failure:** each source has a deadline, and a failed one becomes a named gap in `failures`. RPC errors are not passed on, because a URL can hold a key.
- **Cache:** finished values for 15 seconds, or 5 when partial, per isolate. It stores no promises: on Workers a promise belongs to its request, and a second request waiting on it could hang. On a Worker, `/api/risk` also puts each answer in the colo's Cache API under its parsed address and target, so other isolates in that location answer from it. A hit is checked before the rate limit and costs no upstream call.
- **Rate limit:** 30 reads a minute per client, on `/api/risk` and on `/a/[address]`. On Cloudflare the `RISK_LIMIT` rate limiting binding in `wrangler.jsonc` counts, keyed on `CF-Connecting-IP`. It is free on every plan and counted per location, so it slows a burst rather than enforcing an exact quota. Outside a Worker, or without the binding, a counter in the isolate does the same job.

## Configuration

All optional. Copy `.env.example` to `.dev.vars` for local Worker runs. In production use `wrangler secret put`, because the URLs can hold keys.

| Name | Meaning |
|---|---|
| `RISK_BASE_RPC_URLS`, `RISK_ARBITRUM_RPC_URLS` | Comma-separated mainnet RPC URLs, tried before the public fallbacks. These differ from the keeper's `BASE_RPC_URLS`, which may point at a testnet |
| `RISK_PUBLIC_RPC_FALLBACK` | `off` uses only the URLs above |
| `RISK_HYPERLIQUID_INFO_URL` | Defaults to the public info endpoint |
| `LEVEE_EVIDENCE_DIR` | Where `/how` and `/proof` read run records at build time. Defaults to `../evidence/runs`. The signing test and the fork rehearsal are read from the folder above it |
| `LEVEE_BACKTEST_SUMMARY` | The backtest summary read at build time. Defaults to `../backtest/results/summary.json` |

## Hosting

`wrangler.jsonc` targets `levee.qvkare.com` as a custom domain, with `workers_dev` off. OpenNext builds the Worker. Prerendered pages come from the read-only static assets cache, so no KV or R2 binding is needed, and there is no revalidation: `/`, `/how` and `/proof` change on deploy. The home page takes a fresh reading in the browser. If that fails it keeps the reading from the build and marks it as an example.

Run records and the backtest are read at build time only. A Worker has neither folder, so deploy after adding runs. `next.config.ts` inlines the few figures the report page needs as `LEVEE_BRIEF`.

The mark is `public/levee-mark.svg`, and `public/levee-mark-profile.svg` is its dark form for link previews. `app/favicon.ico`, `app/icon.png` and `app/apple-icon.png` are rendered from those two files, and `app/opengraph-image.png` from the mark and the wordmark on the wall. Render them again if the mark changes.

## Known gaps

- Run on local `workerd` only. Workers egress from shared Cloudflare addresses, so check public RPC and Hyperliquid limits after the first deploy, and set `RISK_*` secrets if they throttle.
- A report makes about 25 subrequests. The Workers free plan allows 50, and its 10 ms CPU limit may be too low for server rendering. The upload is 1.6 MiB gzipped.
- The rate limit counts per Cloudflare location and per isolate off Cloudflare. A spread-out client gets more than 30 reads a minute. A WAF rate limiting rule would be exact, and costs money past the free rule.
- No real account inside the last 5% was found to test against. The red state is covered by unit tests, `?fall=` on a real position and a stand-in Hyperliquid endpoint.
- The stablecoin list is by address. A new reserve counts as volatile until it is added.
- A malformed URL escape such as `/a/%E0%A4%A` gets a plain 500 from the framework. The form cannot produce one.
- Every live run so far is on Base Sepolia, from one position. The hop table says so, and a p95 over that few runs is the slowest run.
- The simulator and the stolen-key table state rules from the spec. They should link to tests and transactions when those exist.
