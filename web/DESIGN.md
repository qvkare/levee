# Levee design direction: Hat

A rescue is a metro line. Read this before adding a page or a component. If the work needs something this document does not allow, change the document first and give the reason.

## Product world

- **Does:** repays a borrower's Aave debt from a USDC reserve when their health factor crosses a trigger they set. A NEAR contract signs the repay, inside caps the borrower set. The position stays in the borrower's wallet, and the keeper cannot send funds anywhere else. The public tool reads any address with no wallet and no login.
- **First ten seconds:** a judge, a screener or a borrower should see what Levee does, that NEAR does the signing in the middle of it, how long it took on a real run, and where to paste an address.
- **What only this product shows:** one real rescue drawn to time across four actors, with its transactions, and every position at one address on one line.
- **Proof data:** the run records in `evidence/runs`, the signing test, and the backtest summary. Every figure on the site comes from them, or from a live read.
- **Worst moment:** a position inside its last 5%. A liquidator can take collateral plus a bonus once health factor reaches 1.00.
- **Never confuse:** read and protected (the tool only reads); live, built, example and simulated; testnet and mainnet; a measured run and a backtest; a debt Levee can repay and one it cannot; missing data and zero; a percentage move and a likelihood.

## Concept

A rescue is a metro line with four lanes, one per actor. Time runs left to right at real scale. The route leaves your position, goes down through the keeper to the Levee contract on NEAR, picks up the signature from the MPC network, and comes back up to the same position. It has one terminus, `Pool.repay(USDC, amount, 2, borrower)`, so the claim that the keeper cannot send funds anywhere else is in the drawing.

| Product fact | Visual |
|---|---|
| An actor | A lane, a colour and a letter badge: P, K, N, M |
| A rescue | The route across the lanes, drawn to time from one real run |
| Time before detection | A grey zone labelled "Before the run, untimed". No record times it |
| A step of the rescue | A stop: a numbered ring on the lane's track |
| Something planned and not built | A dashed track and a dashed ring, in ink 2 |
| The only call a rescue can make | The terminus, ink panel, mono |
| What each actor can do | A board per lane, in the lane's colour |
| Every run | A timetable: a Marey chart for the landed runs, a departures board for all of them, failures included |
| Signing on its own | Purple dots on a time axis, with the median |
| An address's positions | A distance line: liquidation at 0 on the left, each position as a ring at its distance, square-root scale to 250% |
| Below the trigger | Amber, on the replay sign and as the band under the trigger on the distance line |
| Inside the last 5% | The reading's band turns amber and the line zooms to its last 5% |

## Lanes

| Lane | Badge | Colour | Means |
|---|---|---|---|
| Your position | P | `#1F4FD6` | The borrower's Aave position, and anything Levee can repay. The address box sits on it |
| Keeper | K | `#3F4A55` | The off-chain keeper, and neutral notices |
| Levee contract | N | `#087F5B` | The NEAR contract, and links to it |
| MPC network | M | `#6B3FD4` | NEAR Chain Signatures, and signing figures |
| NEAR Intents | I | white, dashed ink 2 | Planned. Not built |

A colour is one actor and nothing else. A position Levee cannot reach is a grey ring in ink 2, so a Hyperliquid position is never drawn in an actor's colour.

## Palette

| Token | Hex | Role | Contrast |
|---|---|---|---|
| `--bg` | `#FFFFFF` | Ground | |
| `--tint` | `#F0F2F4` | Alternate sections, the replay band, cards | |
| `--tint-2` | `#E4E8EC` | The untimed zone | |
| `--ink` | `#121826` | Type, the line, dark panels | 17.7:1 on white |
| `--ink-2` | `#4B5563` | Secondary type, planned things, grey rings | 7.6:1 on white, 6.7:1 on tint |
| `--ink-3` | `#2B3340` | Long text | 12.7:1 |
| `--on-dark` | `#C9D0DA` | Type on ink | 11.4:1 |
| `--P`, `--K`, `--N`, `--M` | above | Lanes | White on each: 6.7, 9.0, 5.0 and 6.4:1 |
| `--P-light` | `#8FA9FF` | A landed run's dot on ink | 7.8:1 |
| `--grey` | `#8A94A0` | Same USDC held as collateral, in the backtest | 3.1:1, a line, with labels in `--grey-ink` 5.7:1 |
| `--amber` | `#F2A100` | Below the trigger, the last 5%, and what is being re-measured. Nothing else | Ink on it 8.3:1 |
| `--amber-soft` | `#FFF0C7` | The band under the trigger | Its label in `--amber-ink`, 6.1:1 |

Amber is a state, never decoration. It marks: the replay's "Below trigger" sign and the first station, the band under the trigger on a distance line, a reading inside the last 5%, the "Being re-measured" tag, and the backtest's upfront-repay line, which is the comparison being re-measured. "Testnet · unaudited" is an ink outline, and "Worst case" an ink tag. The amber line is 2.1:1 on white, so its values are printed beside it in `--amber-ink-2` (4.9:1) and stand in a table on /proof.

## Type

- **Overpass**, variable, 400 to 800, self-hosted in `app/fonts` (OFL). Highway-sign lettering, wide and sturdy at small sizes. 800 for headings, names and figures, 700 for labels, 600 for small type, 400 for text. Headings track at -3%.
- **Overpass Mono** for addresses, transaction hashes, times on the map and the terminus, because `0/O` and `1/l` must not be mixed up.
- The shipped Overpass has one fix: its GDEF table marked the middle dot and the spacing accents as combining marks, so browsers drew "Testnet ·unaudited". They are base glyphs now. Nothing else in the font changed.
- Figures are tabular everywhere (`tnum`). Overpass sits high in its line box, so buttons and tags add 2 to 3 px of top padding.
- Drawings size their label boxes from `lib/text-width.ts`, the font's own advance widths, so a sign fits its text on the server too.

At most six sizes plus display, seven in all. Every `font-size` uses a token. No literal sizes.

| Token | Size | Use |
|---|---|---|
| `--t-xs` | 13 px | Labels, tags, axis ticks, map times, table heads |
| `--t-s` | 15 px | Secondary text, nav, cards, boards, tables |
| `--t-m` | 17 px | Body, lede, band and card titles, the address box |
| `--t-l` | 20 px | Card and stop titles, the brand, board names |
| `--t-code` | 30 px | The terminus |
| `--t-xl` | 32 to 48 px | Section headings, the last-5% figure on its line |
| `--t-xxl` | 38 to 58 px, display | Page headings, the figures on the replay's signs, the last-5% heading |

`lib/type-scale.ts` states the same numbers for the drawings, and a test holds the two together.

## Space and layout

- Page gutter `--pad`: 20 px at phone width, 4vw, 56 px at most.
- Steps: 4, 8, 12, 16, 24, 32, 44, 56 and 104 px (`--s1` to `--s9`). Sections are 104 px apart, 72 at phone width.
- Section heads are a 7:5 grid: the heading left, one plain paragraph right, aligned to the bottom.
- Radii: 6 to 8 px on controls and tags, 12 to 14 px on cards and panels.
- 1180 px and under: the strip of stops goes to four columns, boards to two, the timetable and backtest to one column.
- 820 px and under: the map turns vertical, time running down, with its key above it. The stops become a vertical line. The nav moves under the header as a scrolling row. Every control is at least 44 px tall.
- No horizontal page scroll at 390, 768, 1024, 1440 or 1920. A wide table scrolls inside itself.

## Components

| Component | Where | Notes |
|---|---|---|
| `SiteHeader`, `SiteFooter` | Every page | Brand, five links, "Testnet · unaudited". The footer says not to use it with funds you can't lose |
| `AddressForm` | Home, `/a` | The blue plate. A GET form that works without scripts, with the shape checked in place |
| `RescueMap` | Home | The replay. Server-drawn at 1328 and 350 px, redrawn at the real width |
| `StopStrip`, `StopLine`, `Terminus` | Home, `/how` | Seven stops, the measured hop on each, the planned one dashed |
| `Boards`, `WorstCase` | Home, `/how` | One board per lane |
| `Timetable`, `Marey`, `Departures`, `SigningDots` | Home, `/proof` | Every run, the aborted one included |
| `BacktestBody`, `BacktestChart`, `BacktestTable` | Home, `/proof` | Three rows, always together, under "Being re-measured" |
| `DistanceLine` | Home, `/a` | Horizontal from 560 px, vertical under it. Labels take the nearest free row |
| `CrisisBand` | `/a` | The last 5% |
| `RouteQuotePanel` | `/how` | The live NEAR Intents dry quote, under the planned stop |

## Figures

Every number about Levee itself comes from `lib/proof-model.ts`, through `PROOF` in `lib/proof.ts`, which `next.config.ts` works out at build time from `evidence/` and the backtest summary. No page types a figure. The replay is the landed run whose total is the median total, picked by code. Address figures come from `/api/risk` or the same read on the server.

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

- The replay is the only animation, and it is data: the route draws itself at the run's real speed.
- Nothing moves on scroll except that the replay waits to be seen before it plays. Nothing counts up. Nothing loops.
- With `prefers-reduced-motion: reduce`, nothing plays by itself and nothing slides.

## Copy

- English, short and concrete. Say what happened, with the figure and where it comes from.
- Headings are names, with no full stop: "Stop by stop", "Who can do what".
- No "X, not Y" turns. Say the thing and stop.
- No hype words. See the filler list below.
- "Testnet · unaudited" in the header, and the footer says not to use it with funds you can't lose. Once or twice, not in every section.
- Labels say testnet, example, simulation, planned and being re-measured where those apply.
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

## Checks

- `pnpm --filter web test` and `typecheck` pass.
- Screenshots at 390 and 1440 of every page and every `/a` state, and the three replay frames, compared with `tasarim/tur-2/b`. Spot checks at 768, 1024 and 1920 for overflow.
- Keyboard: skip link, nav, the address box, Read, the replay button and its signs, Read again, the target and fall fields, with a visible focus ring on white, tint, blue, ink and amber.
- Reduced motion: the replay waits, and steps when asked.
