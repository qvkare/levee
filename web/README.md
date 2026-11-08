<img src="public/levee-mark.svg" width="56" height="56" alt="Levee">

# Levee web

The Levee site and public risk tool. Levee repays Aave debt from the borrower's own collateral when health factor falls below their trigger, and the site shows how, with every testnet run and the backtest. Paste any address and read how close it is to liquidation on Aave (Base and Arbitrum) and Hyperliquid. No wallet and no login.

It runs on Cloudflare Workers at `levee.qvkare.com`. Unaudited. It reads public data and holds no funds.

Spec: `../docs/SPEC.md`. Design direction: `DESIGN.md`. Read it before changing the interface.

## Run it

```bash
pnpm install
pnpm --filter web dev            # next dev
pnpm --filter web test           # unit tests, Node's own runner
pnpm --filter web typecheck
pnpm --filter web run preview    # OpenNext build, then the real Worker on local workerd, port 8787
pnpm --filter web run deploy     # build and deploy. Needs wrangler login
```

Use `run` for `deploy`: `pnpm deploy` without it is a pnpm command of its own.

## Pages

| Path | What it is |
|---|---|
| `/` | The offer, what ran live, and the address box, a replay of one real testnet rescue from collateral drawn to time across four lanes and ending at the helper, the stops of a rescue and the terminus, who can do what, the timetable of every run in both modes, the collateral backtest with its caveats, and a real reading of one public address on the distance line, read again in the browser. Prerendered |
| `/a/[address]` | Any address on the distance line, then every figure, what each Aave position holds and what Levee would do. Rendered on the server and read again in the browser every minute. `?target=1.75` sets the repay target. `?fall=11.1` marks the nearest Aave position's collateral down by that percentage and says it is a simulation |
| `/how` | The full line stop by stop, the terminus and the helper's checks, the formula, who can do what, what a stolen key cannot do, what is different, failure conditions, the measured hops of both modes, the reserve as the second mode with a live dry quote from `/api/route` under its planned stop, what is not built yet, limits, how to read a distance, and the API shape. Prerendered |
| `/proof` | The timetable, the contracts with explorer links and the two key deletions, every hop's median and p95 per mode, every file in `../evidence/runs` with explorer links and the sale of each collateral run, failures included, every signing sample, the fork rehearsal under its own label, the collateral backtest with its money, misses, size split and caveats, and the reserve backtest as the second mode's. Prerendered |

The replay on the home page is the landed run the claims ledger ties to both contract accounts having no keys (`contracts-keyless-rescue-after`). Without such a claim it is the landed collateral run at the median total. Code picks it at build time. The fall before detection is in no record, so it is drawn in a zone marked untimed.

Testnet sale prices come from a pool the team seeded at Aave's oracle price, and every page that prints one says so.

A reading with a position inside its last 5% turns its band amber and zooms the line to that 5%. The home page passes over a third party's address in that state, because the state is for an address someone asked about.

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
| `LEVEE_EVIDENCE_DIR` | Where `/how` and `/proof` read run records at build time. Defaults to `../evidence/runs`. The claims ledger, the signing test and the fork rehearsal are read from the folder above it |
| `LEVEE_BACKTEST_COLLATERAL` | The collateral backtest read at build time. Defaults to `../backtest/results/collateral.json` |
| `LEVEE_BACKTEST_SUMMARY` | The reserve-mode backtest summary read at build time. Defaults to `../backtest/results/summary.json` |

## Hosting

`wrangler.jsonc` targets `levee.qvkare.com` as a custom domain, with `workers_dev` off. OpenNext builds the Worker. Prerendered pages come from the read-only static assets cache, so no KV or R2 binding is needed, and there is no revalidation: `/`, `/how` and `/proof` change on deploy. The home page takes a fresh reading in the browser. If that fails it keeps the reading from the build and marks it as an example.

Run records, the claims ledger and the backtests are read at build time only. A Worker has none of those folders, so deploy after adding runs. Every figure the site states about Levee is worked out once, in `lib/proof-model.ts`, and `next.config.ts` inlines the result as `LEVEE_PROOF`, so prerendered pages and pages rendered on the Worker print the same numbers. Pages read it as `PROOF` from `lib/proof.ts`. Contract addresses and the key deletions are data in `lib/contracts.ts`. Tests hold the hop table, the backtest table, the caveats' figures and every contract link to the root README and the claims ledger, so the two cannot drift apart without a failing test.

The repository is private, so `GITHUB_URL` in `lib/links.ts` is empty and nothing links to it. Set it, and the footer and the proof cards pick it up.

The mark is `public/levee-mark.svg`, and `public/levee-mark-profile.svg` is its dark form. `app/favicon.ico`, `app/icon.png` and `app/apple-icon.png` are rendered from those two files. `app/opengraph-image.png` is the link preview: the four lanes, the route of the replayed run ending at the helper's square, and the median of the collateral rescues, rendered by `node tools/og-image.ts` from the same figures. A test fails when its alt text no longer matches the run records, which means it is time to render it again.

The fonts are Overpass and Overpass Mono (OFL), in `app/fonts`. The Overpass file has one change from upstream: its GDEF table marked the middle dot and the spacing accents as combining marks, which made browsers draw them with no width, so they are base glyphs now.

## Known gaps

- Run on local `workerd` only. Workers egress from shared Cloudflare addresses, so check public RPC and Hyperliquid limits after the first deploy, and set `RISK_*` secrets if they throttle.
- A report makes about 25 subrequests. The Workers free plan allows 50, and its 10 ms CPU limit may be too low for server rendering. The upload is 1.6 MiB gzipped.
- The rate limit counts per Cloudflare location and per isolate off Cloudflare. A spread-out client gets more than 30 reads a minute. A WAF rate limiting rule would be exact, and costs money past the free rule.
- No real account inside the last 5% was found to test against. The amber state is covered by unit tests and `?fall=` on a real position.
- The stablecoin list is by address. A new reserve counts as volatile until it is added.
- A malformed URL escape such as `/a/%E0%A4%A` gets a plain 500 from the framework. The form cannot produce one.
- Every live run so far is on Base Sepolia, from one position: six rescues from collateral and thirteen from a reserve. The hop table says so, and a p95 over that few runs is the slowest run.
- The stolen-key table and the boards state rules from the spec and name the claims ledger. They should link to each test and transaction.
- `make verify` reads the contract accounts' key lists live. The site states the deletions from `lib/contracts.ts` at build time and does not read NEAR itself.
- The replay draws the fall before detection from the record's own figures: health factor goes from where the previous run left it to the reading at detection. How long that took is not recorded.
