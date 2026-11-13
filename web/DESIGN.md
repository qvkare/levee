# Levee design direction: Hat

A rescue is a metro line. Read this before adding a page or a component. If the work needs something this document does not allow, change the document first and give the reason.

## Product world

- **Does:** when an Aave health factor falls below the borrower's trigger, Levee sells just enough of the borrower's own collateral to repay USDC debt back to their target. A NEAR contract with no keys signs one call, and an ownerless helper on the lending chain, `LeveeUnwind`, checks the trigger, the collateral and pool, and the price against Aave's oracle before anything moves. The position stays in the borrower's wallet. Repaying from a USDC reserve is a second mode. The public tool reads any address with no wallet and no login.
- **First ten seconds:** a judge, a screener or a borrower should see what Levee does, that it sells the borrower's own collateral inside a bound checked on chain, that NEAR does the signing, that it ran on testnet after the contracts lost their keys, how long it took, and where to paste an address.
- **What only this product shows:** one real rescue drawn to time across four actors and ending at the helper, with its transactions, and every position at one address on one line.
- **Proof data:** the run records in `evidence/runs`, the claims ledger `evidence/claims.json`, the signing test, the collateral backtest (`backtest/results/collateral.json`) and, for the reserve mode, the backtest summary. Every figure on the site comes from them, or from a live read.
- **What it may claim:** an ownerless, immutable helper; the trigger checked on chain and the sale price bounded against Aave's oracle on chain; no Safe, module or credit delegation; one NEAR policy across chains, in a contract with no keys. It never claims to be the only or the first way to protect a position without moving it: DeFi Saver protects Aave v3 positions held in an EOA on Base and Arbitrum. It never claims lower cost or better execution.
- **Worst moment:** a position inside its last 5%. A liquidator can take collateral plus a bonus once health factor reaches 1.00.
- **Never confuse:** read and protected (the tool only reads); live, built, planned, example and simulated; testnet and mainnet (nothing is on a mainnet); a measured run and a backtest; repaying from collateral and repaying from a reserve; a testnet sale price and a measure of slippage; a debt Levee can repay and one it cannot; missing data and zero; a percentage move and a likelihood.

## Concept

A rescue is a metro line with four lanes, one per actor. Time runs left to right at real scale. The route leaves your position, goes down through the keeper to the Levee contract on NEAR, picks up the signature from the MPC network, and comes back up to the same position. It has one terminus, `LeveeUnwind.unwind(borrower, collateral, amount, poolFee, maxSold)`, so the claim that a rescue can only sell the collateral the borrower named, to repay their own debt, is in the drawing.

| Product fact | Visual |
|---|---|
| An actor | A lane, a colour and a letter badge: P, K, N, M |
| A rescue | The route across the lanes, drawn to time from one real run |
| Time before detection | A grey zone labelled "Before the run, untimed". No record times it |
| A step of the rescue | A stop: a numbered ring on the lane's track |
| The helper, `LeveeUnwind` | The terminus. An ink square on the P lane where the route ends, the ink terminus panel with its call and its checks, and an ink board |
| Something planned and not built | A dashed track and a dashed ring, in ink 2 |
| The only call a rescue can make | The terminus, ink panel, mono |
| What each actor can do | A board per actor, in its lane's colour |
| Every run | A timetable: a Marey chart for the landed runs, a departures board for all of them, failures included, grouped by mode |
| Signing on its own | Purple dots on a time axis, with the median |
| The backtest | Bars of liquidated positions saved, one panel per period: doing nothing at zero, collateral mode at both price bounds in ink, the reserve and the upfront repay in grey. The money in a table, its caveats under it |
| An address's positions | A distance line: liquidation at 0 on the left, each position as a ring at its distance, square-root scale to 250% |
| Below the trigger | Amber, on the replay sign and as the band under the trigger on the distance line |
| Inside the last 5% | The reading's band turns amber and the line zooms to its last 5% |

Why the helper sits on the P lane and has no lane of its own: it has no owner and no discretion. It acts only on the terms the borrower set with `authorize`, from the borrower's own position, in the same transaction that repays their debt. A fifth lane would draw it as a party with a will of its own, and would crowd the phone map, where the four lanes take the left half of a 350 px drawing. A square tells it apart from the ring stops at the size a thumb sees, and ink ties it to the terminus panel, which spells out the one call and what the helper checks.

## The first screen: the levee

The homepage opens on the product's name drawn as its mechanism, `components/levee-hero.tsx`. The headline is "Hold the line." and the copy is one sentence. There are two buttons: "Watch a real rescue" goes to the replay below, and "Read an address" goes to the reading tool. The address box moved from the first screen into "Read any address".

| In the drawing | Is |
|---|---|
| A levee of blue bricks, in the position's blue | The borrower's collateral |
| Grey water against it | The borrower's USDC debt |
| Water at the top of the levee | Health factor 1.00, liquidation |
| A staff gauge in the water, marked at the trigger and the target | The terms the borrower set in `authorize` |
| One dark brick on top | The slice the borrower allowed, which a rescue sells |
| The route through K, N and M to an ink U on the levee | The keeper, the keyless contract on NEAR, the MPC signature, and `LeveeUnwind` |
| The brick carried to the Uniswap pool, and a coin dropped into the water | The sale, and the USDC repaid |
| A wallet behind the levee | The position, which never leaves it |

It is one 12 s loop of the replayed run, and every figure in it comes from that run's record: health factor before and after, trigger, target, the USDC repaid, the collateral sold, the chain, the date, and the time from detection to inclusion. The card beside it says the drawing is an animation, the run's real time, and that it is shown faster. The water rises past the trigger, the route draws stop by stop, the brick goes, the water falls back to the target, and the loop rests. One motion at a time. Pause stops it, reduced motion stills it, and the still frame is the end of the rescue. Nothing in it is decoration: it has no gradient, glow or particles. On a phone, the drawing is cropped to its middle: the route, the pool and the levee.

## Lanes

| Lane | Badge | Colour | Means |
|---|---|---|---|
| Your position | P | `#1F4FD6` | The borrower's Aave position, the terms they set in `LeveeUnwind`, and anything Levee can repay. The address box and the helper's square sit on it |
| Keeper | K | `#3F4A55` | The off-chain keeper, and neutral notices |
| Levee contract | N | `#087F5B` | The NEAR contract, and links to it |
| MPC network | M | `#6B3FD4` | NEAR Chain Signatures, and signing figures |
| NEAR Intents | I | white, dashed ink 2 | Planned, for the reserve mode. Not built |

A colour is one actor and nothing else. A position Levee cannot reach is a grey ring in ink 2, so a Hyperliquid position is never drawn in an actor's colour.

Two actors have a board and no lane. `LeveeUnwind` is ink, badge U, because it is the terminus. The owner, the NEAR account that registers a position and sets its caps, has a `--tint-2` header with ink type and badge O, because it takes no part in a rescue.

## Palette

| Token | Hex | Role | Contrast |
|---|---|---|---|
| `--bg` | `#FFFFFF` | Ground | |
| `--tint` | `#F0F2F4` | Alternate sections, the replay band, cards | |
| `--tint-2` | `#E4E8EC` | The untimed zone, the owner's board | |
| `--ink` | `#121826` | Type, the line, dark panels, the helper | 17.7:1 on white |
| `--ink-2` | `#4B5563` | Secondary type, planned things, grey rings | 7.6:1 on white, 6.7:1 on tint |
| `--ink-3` | `#2B3340` | Long text | 12.7:1 |
| `--on-dark` | `#C9D0DA` | Type on ink | 11.4:1 |
| `--P`, `--K`, `--N`, `--M` | above | Lanes | White on each: 6.7, 9.0, 5.0 and 6.4:1 |
| `--P-light` | `#8FA9FF` | A landed run's dot on ink | 7.8:1 |
| `--grey` | `#8A94A0` | The backtest's comparisons that need cash in hand, the reserve and the upfront repay, and reserve runs on the Marey chart | 3.1:1, a bar or line, with labels in `--grey-ink` 5.7:1 |
| `--amber` | `#F2A100` | Below the trigger and the last 5%. Nothing else | Ink on it 8.3:1 |
| `--amber-soft` | `#FFF0C7` | The band under the trigger | Its label in `--amber-ink`, 6.1:1 |

Amber is a state, never decoration. It marks: the replay's "Below trigger" sign and the first station, the band under the trigger on a distance line, and a reading inside the last 5%. "Testnet" is an ink outline, and "Worst case" an ink tag. The earlier "Being re-measured" tag is retired: the collateral backtest is the measured answer, and the reserve backtest it replaced is shown as the second mode's result, in grey.

## Type

- **Overpass**, variable, 400 to 800, self-hosted in `app/fonts` (OFL). Highway-sign lettering, wide and sturdy at small sizes. 800 for headings, names and figures, 700 for labels, 600 for small type, 400 for text. Headings track at -3%.
- **Overpass Mono** for addresses, transaction hashes, times on the map and the terminus, because `0/O` and `1/l` must not be mixed up.
- The shipped Overpass has one fix: its GDEF table marked the middle dot and the spacing accents as combining marks, so browsers glued a middle dot to the word after it. They are base glyphs now. Nothing else in the font changed.
- Figures are tabular everywhere (`tnum`). Overpass sits high in its line box, so buttons and tags add 2 to 3 px of top padding.
- Drawings size their label boxes from `lib/text-width.ts`, the font's own advance widths, so a sign fits its text on the server too.

At most six sizes plus display, seven in all. Every `font-size` uses a token. No literal sizes.

| Token | Size | Use |
|---|---|---|
| `--t-xs` | 13 px | Labels, tags, axis ticks, map times, table heads |
| `--t-s` | 15 px | Secondary text, nav, cards, boards, tables |
| `--t-m` | 17 px | Body, lede, band and card titles, the address box |
| `--t-l` | 20 px | Card and stop titles, the brand, board names, the terminus at phone width |
| `--t-code` | 30 px | The terminus |
| `--t-xl` | 32 to 48 px | Section headings, the last-5% figure on its line |
| `--t-xxl` | 38 to 58 px, display | Page headings, the figures on the replay's signs, the last-5% heading |

The terminus call is long, so it breaks between its arguments and never inside one.

`lib/type-scale.ts` states the same numbers for the drawings, and a test holds the two together.

## Space and layout

- Page gutter `--pad`: 20 px at phone width, 4vw, 56 px at most.
- Steps: 4, 8, 12, 16, 24, 32, 44, 56 and 104 px (`--s1` to `--s9`). Sections are 104 px apart, 72 at phone width.
- Section heads are a 7:5 grid: the heading left, one plain paragraph right, aligned to the bottom.
- Radii: 6 to 8 px on controls and tags, 12 to 14 px on cards and panels.
- 1180 px and under: the strip of stops goes to four columns, boards to two, the timetable and backtest to one column.
- 820 px and under: the map turns vertical, time running down, with its key above it. The stops become a vertical line. The nav moves under the header as a scrolling row. Every control is at least 44 px tall.
- No horizontal page scroll at 390, 768, 1024, 1440 or 1920. A wide table scrolls inside itself. An address in a table breaks anywhere rather than widen it.

## Components

| Component | Where | Notes |
|---|---|---|
| `SiteHeader`, `SiteFooter` | Every page | Brand, five links, "Testnet". The footer says nothing is on any mainnet, and links the v0.2 contract and the helper |
| `AddressForm` | Home, `/a` | The blue plate. A GET form that works without scripts, with the shape checked in place |
| `RescueMap` | Home | The replay. Server-drawn at 1328 and 350 px, redrawn at the real width. Ends at the helper's square |
| `StopStrip`, `StopLine`, `Terminus` | Home, `/how` | Seven stops: the borrower's terms, then the six of every rescue, the helper's on the P lane. The terminus is `LeveeUnwind.unwind` with its four checks |
| `ReserveLine` | `/how` | The second mode: `rescue` and `Pool.repay`, and the planned NEAR Intents stop, dashed, with the live dry quote |
| `Boards`, `WorstCase` | Home, `/how` | Six boards: borrower, `LeveeUnwind`, keeper, NEAR contract, MPC network, owner |
| `Timetable`, `Marey`, `Departures`, `SigningDots` | Home, `/proof` | Every run, the aborted ones included, collateral and reserve told apart |
| `BacktestBody`, `BacktestChart`, `BacktestMoney` | Home, `/proof` | Collateral mode against doing nothing, the reserve and the upfront repay, three periods, both bounds. The caveats are inside the body, so a net figure never travels without them. The home page leaves out the money table; `/proof` adds it, the misses and the split by size |
| `ReserveBacktest` | `/proof` | The reserve mode's backtest, by reserve size, with its finding |
| `ContractsTable`, `KeylessTable` | `/proof` | Every contract with an explorer link, and the two key deletions |
| `DistanceLine` | Home, `/a` | Horizontal from 560 px, vertical under it. Labels take the nearest free row |
| `CrisisBand` | `/a` | The last 5% |
| `RouteQuotePanel` | `/how` | The live NEAR Intents dry quote, under the planned stop of the reserve mode |

## Figures

Every number about Levee itself comes from `lib/proof-model.ts`, through `PROOF` in `lib/proof.ts`, which `next.config.ts` works out at build time from `evidence/`, the claims ledger and the backtest results. No page types a figure. The replay is the landed run the claims ledger ties to the contracts having no keys, picked by code. Without such a claim it is the landed collateral run at the median total. A median is the middle value, or the mean of the two middle values; a p95 is nearest rank, so with few runs it is the slowest. Contract addresses and the key deletions are data in `lib/contracts.ts`, copied from the README, and a test holds them to the claims ledger and the run records. Address figures come from `/api/risk` or the same read on the server.

## States

| State | What the page does |
|---|---|
| Replay | Plays once, at real speed, the first time the map is mostly on screen. Pause, Play and Replay on one button. A sign can be clicked to jump to its moment |
| Reduced motion | The replay does not play by itself. Replay steps through the recorded moments with nothing sliding |
| Built example | The home reading is real at a stated time and is read again on load. If that read fails it says so |
| Populated | `/a`: the nearest position as the heading, the verdict, the read time, Read again and the JSON, then the line, every figure and what Levee would do |
| No positions | "Nothing here can be liquidated", the verdict, and the empty line saying "No position to place" |
| Invalid address | "That isn't an address Levee can read", the reason under the box, the empty line |
| Partial | A keeper-grey notice naming each source that did not answer, and why. Its positions are missing from the line, and nothing counts them as zero |
| Unavailable | "No source answered" and Read again |
| Loading | A new address clears the page at once (`loading.tsx`). Inside `/a`, a new read or Read again fades the old figures to 30% and says "Reading" |
| Rate limited | "Too many reads from this connection", the limit, and Read again |
| Last 5% | The reading's band turns amber: an ink tag, the position and its distance as the heading, the line from liquidation to 5% with the position on it, the sentence, three figures and two lines for everything else. Only a reading or a `?fall=` simulation sets it, and a simulation says so first |
| Simulation | `?fall=` on `/a`: "Simulation." in bold, what was changed, and a way back to the live reading |
| Dry quote | Under the planned stop on `/how`: "Dry quote.", nothing moves, then the figures or "unavailable" |

The home page shows a third party's address only to show the tool, so it passes over a position inside the last 5%.

## Motion

- The replay is the only animation at real speed, and it is data: the route draws itself at the run's real speed.
- The levee on the first screen is the one loop. It is labelled as an animation shown faster, it draws only the replayed run's recorded figures, and it has Pause.
- Nothing moves on scroll except that the replay waits to be seen before it plays. Nothing counts up.
- With `prefers-reduced-motion: reduce`, nothing plays by itself and nothing slides.

## Copy

- English, short and concrete. Say what happened, with the figure and where it comes from.
- Headings are names, with no full stop: "Stop by stop", "Who can do what".
- No "X, not Y" turns. Say the thing and stop.
- No hype words. See the filler list below.
- "Testnet" in the header, and the footer says nothing is on any mainnet. Once or twice, not in every section.
- Labels say testnet, example, simulation, planned and backtest where those apply.
- A testnet sale price always says that the team seeded the pool at Aave's oracle price, so it is no measure of slippage.
- A backtest net figure always stands with its caveats: positions already below the trigger, pools that lagged the oracle, gas on reverted unwinds, and one sale alone in its block with nothing annualised.
- Reserve mode is named as the second mode, and the backtest's finding stands with it: the same USDC repaid upfront protects as well as a reserve.
- Example addresses carry neutral labels, and Levee says it has no relationship with them.
- The GitHub link is one constant in `lib/links.ts`. While it is empty, nothing links to the repository and nothing says a link is coming.

## Banned

Universal: gradients, gradient or clipped text, default indigo and violet, glows, blur panels, default typefaces, em dashes, emoji, arrow glyphs welded to links, tracked all-caps eyebrows, 01/02/03 markers, scroll and attention motion, count-ups, filler copy, placeholder people, round unsourced numbers, claims no table backs (never, guaranteed, trustless, within seconds), italic.

Product-specific:

- Literal colours in components. Colour comes from the tokens.
- Amber for anything outside its states.
- A literal type size, or more sizes than allowed.
- Headings with a full stop, "X, not Y" in the interface.
- Water imagery and the retired vocabulary: rivers, floods, gauges, staff, freeboard, crest, drills, the wall.
- A dark theme. Sponsor colours as decoration. Health pills, gauge dials, sparklines, KPI tiles, icon cards.
- Presenting a distance as a likelihood.
- A third-party address named as an example of anything negative.
- Calling Levee the only or the first to protect a position in place, or cheaper than another tool.

## Checks

- `pnpm --filter web test` and `typecheck` pass.
- Screenshots at 390 and 1440 of every page and every `/a` state, and the three replay frames, compared with `tasarim/tur-3`. Spot checks at 768, 1024 and 1920 for overflow.
- Keyboard: skip link, nav, the address box, Read, the replay button and its signs, Read again, the target and fall fields, with a visible focus ring on white, tint, blue, ink and amber.
- Reduced motion: the replay waits, and steps when asked.
