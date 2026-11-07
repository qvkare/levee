# Levee design direction: the order

Every position at an address stands at its true distance from the liquidation wall, and its type size is set by that distance. Read this before adding a page or a component. If the work needs something this document does not allow, change the document first and give the reason. `pnpm --filter web design-check` enforces the bans below.

## Product world

- **Does:** repays a borrower's Aave debt from a reserve when their health factor crosses a trigger they set. The position stays in the borrower's wallet, and the keeper cannot send funds anywhere else. The public tool reads any address with no wallet and no login.
- **First ten seconds:** a judge, a screener or a borrower pastes an address and wants to see which position goes first, how far it is, what Levee could do about it, and whether the numbers are real.
- **What only this product shows:** every position at one address, across Aave on Base, Aave on Arbitrum and Hyperliquid, in one order. No venue shows positions outside itself.
- **Proof data:** a real public position, read from Aave at a stated block and from Hyperliquid at a stated time, with the exact contract outputs in `/api/risk` so anyone can repeat the read.
- **Worst moment:** a position inside its last 5%. A liquidator can take collateral plus a bonus once health factor reaches 1.00.
- **Never confuse:** read and protected (the tool only reads); live, built, example and simulated; cross and isolated; a market fall and a fall relative to debt; a debt Levee can repay and one it cannot; missing data and zero; a percentage move and a likelihood.

## Neighbours surveyed

Measured with Playwright at 1440 x 900 on 7 Nov 2026: the first screen, its DOM text and its colour areas.

| Site | Signature element | Largest type | Real data |
|---|---|---|---|
| app.aave.com | Plain market table | Inter Variable 30/500 | The whole table is live |
| app.hyperliquid.xyz | A terminal built on one type size | 20/400, body 12 | Everything is live, 90 figures |
| fluid.io | One number on the screen | Satoshi 20/400, the number in canvas | One live TVL |
| morpho.org | Wire curve on a gridded field | FK Grotesk 59/300 | Amounts to the dollar |
| tsunami.gov | One sentence band that states the state | Arial 24/700 | Live state |
| grid.iamkate.com | `Demand = Generation + Transfers` | Proza 40/400 | Live grid |
| gridstatus.io/live | A table-first console | Helvetica Neue 18/600 | Live market |
| windy.com | The data field is the ground | 67/400 | Everything is live |

Shared baseline: one sans family, a large left or centred headline, real figures made visible. Tools sit at 26 to 90 figures, marketing pages at 0 to 3. The dense ones stay calm by using few sizes.

Nobody does: put every position at an address in one order across venues, or let the data set the type.

## Concept

The wall is liquidation. Each position hangs from it on a stem as long as its distance, and the number at the end of the stem is set at a size the distance decides. Near means large. The rule makes the crisis by itself: at 1.2% the size would be 2100 px, which no page holds, so inside the last 5% the wall takes the page.

| Product fact | Visual |
|---|---|
| Liquidation | The wall: a 12 px ink bar at the right edge of the label column, from the header to the foot of the board |
| Distance to liquidation | The stem's length and the number's position on one axis, 0% at the wall and 100% at the end |
| How near | Type size, by the rule below |
| Order | Top to bottom, nearest first. It is percentage move, not likelihood, and every wall says so |
| Over 100% away | Off the axis, named in one line under it, and in the table |
| A position Levee cannot reach (non-USDC debt, isolated margin, other DEX collateral) | The number in outline: paper fill, ink stroke |
| A debt Levee cannot repay | Outline, plus an ink band across the page that says so, and the repay figure struck in the table |
| Inside the last 5% | The whole page turns crisis red. The number fills the screen, and the rest of the address folds into two lines |
| A simulation | The word Simulation in bold, at the start of a sentence that says what was changed |
| A source that did not answer | Named in a line under the wall: missing, not zero |
| What a rescue does | The simulator: the same position with and without Levee, on the same wall |
| Time on /proof | The same wall in seconds: each moment of a rescue at its median time from detection |

## The rule

`size = 2520 / distance`, in pixels, with distance in percent, held between 15 px and 208 px. 12.1% sets 208 px, 42.9% sets 59 px, 87.2% sets 29 px.

| Width | k | Smallest | Largest |
|---|---|---|---|
| Over 1180 px | 2520 | 15 px | 208 px |
| 761 to 1180 px | 1900 | 15 px | 157 px |
| 760 px and under | 1120 | 19 px | 92 px |

The rule lives in CSS (`--k`, `--size-min`, `--size-max` in `app/globals.css`), so the page holds with no script. `lib/punto.ts` holds the same numbers for deciding how much label a row has room for, and a test holds the two together. Rows over 120 px get a name and two lines, rows from 44 px a name and one, smaller rows one line in all. Nothing else sets the size of a number on the wall.

## Palette

| Token | Hex | Role | Contrast on its ground |
|---|---|---|---|
| Paper | `#FFFFFF` | Ground | |
| Ink | `#101A22` | The logo's colour. Type, wall, stems, the band | 17.6:1 |
| Ink 2 | `#55626D` | Secondary type | 6.3:1 |
| Rule | `#D9DEE2` | Table rows, the simulator's trigger and target lines | Not for type |
| Crisis | `#E4231B` | The whole page, inside the last 5%. Nothing else, nowhere else | White on it 4.6:1 |

The first screen is one colour. Crisis red is a state of the page, set by `data-crisis="on"` on a container: `html:has([data-crisis="on"])` turns every token, so paper becomes red and ink becomes white. No component carries its own red, and it is never a small accent.

## Type

- **Schibsted Grotesk**, variable, self-hosted (`app/fonts`, OFL). 500 for numbers and headings, 600 for names in the label column and bold, 400 for text. Letter spacing -5% on wall numbers, -4% on headings. Wall numbers have a line height of 0.84.
- **Atkinson Hyperlegible Mono** for addresses and run ids, because `0/O` and `1/l` cannot be mixed up in a string someone pastes.
- Tables use tabular figures. Schibsted widens punctuation in that mode, so `<Num>` pulls `, . :` back in. Header cells and the first column stay proportional.
- Sizes outside the rule: 47 px headline, 33 px section heading, 23 px name, 16.5 px text, 15.5 px labels, 13.5 px axis. No italic.

## Grid

- A 264 px label column, the 12 px wall at its right edge, then the axis. The axis is the width less the label column, a 44 px right margin and 64 px of room for the last number, so 1% is about 10.7 px at 1440.
- The header row is the same grid: mark and wordmark in the label column, the address box on the axis, links at the right.
- Under the board, sections run full width with a 3 px ink rule on top and a 33 px heading.
- 1180 px and under: a 210 px label column, links under the address box. 760 px and under: the wall moves to the left edge, each number sits on its stem with its label under it, and the axis ticks go.
- No horizontal scroll at 375, 820, 1440 or 1920. A wide table scrolls inside itself.

## Mark

`public/levee-mark.svg`, in `#101A22` only, 31 px beside the wordmark set in Schibsted Grotesk 600. It stays ink on the red page. It is not recoloured, outlined or animated.

## Components

| Component | Where | Notes |
|---|---|---|
| `SiteHeader` | Every page | Mark, wordmark, address box, links. `BareHeader` in the last 5% |
| `Run`, `Axis` | Wall | A list: each row reads name, lines, distance |
| `CrisisView` | Last 5% | Lead line, number, two lines for the rest, sentence, three figures |
| `FiguresTable` | Report | Every figure in the wall's order. At phone width four columns and one line under each row |
| `Holdings` | Report | Each Aave asset, terms, Hyperliquid pools and notes |
| `Simulator` | Home | Two rows, a fall slider marked with the keeper and liquidation, the terms, and what follows |
| `TextTable`, `MeasuredTable` | `/how`, `/proof` | Words stack at phone width, roles kept |

## States

| State | What the page does |
|---|---|
| Live | `Read 20:35:05 UTC` under the wall, `Read again`, and a new read every minute while the tab is visible |
| Built | The home page's HTML. Replaced by a live read on load |
| Example | The read failed: the earlier reading stays, and the line says `Example, not live` and why |
| Simulation | `?fall=` on a report, or the simulator. Bold `Simulation.` and what was changed |
| Dry quote | `/how`, under the refill step: a live NEAR Intents quote asked from the browser. Bold `Dry quote.`, that nothing moves and the reserve layer is not built, then amount out, time estimate, confidential or not, and the quote time. If the route fails it says the route is unavailable |
| Last 5% | Red page, number fills the screen, two lines for the rest |
| Cannot repay | Outline, ink band, struck repay, `What Levee does with the first row: nothing.` |
| Not covered | Outline and `Not covered` beside the number and in the table |
| Partial | A line naming each source that did not answer |
| Unavailable, empty, loading | A heading in the axis column and one plain paragraph. The wall still stands |
| Rate limited | `Too many reads from this connection` and the limit |

The home page shows a third party's address only to show the tool, so it passes over a position inside the last 5% and falls back to the next address or the stored example. The red page is for an address someone asked about, or a simulation.

## Motion

- On a new reading the numbers slide along the axis and resize, in 220 ms. `--d` is a registered custom property, so position, stem and size follow one value and move as one.
- The simulator's numbers move the same way as the fall is dragged, and the trigger and target lines follow their inputs.
- Nothing moves on scroll, nothing counts up, nothing loops. With `prefers-reduced-motion: reduce` the numbers jump.

## Voice

- Plain sentences, full stops, the reader as "you" only where it is their position. Headings are sentences: `The same order, every figure.`
- Every figure is computed from a read or a file. Numbers on `/proof`, `/how` and the backtest come from `evidence/` and `backtest/results/` at build time.
- Say what is measured and how much: `13 full runs on Base Sepolia, a testnet, from one position.` A p95 over few runs is called the slowest run.
- Unaudited, read only, testnet: every page carries them in the footer, and the report says them beside what Levee would do.
- Example addresses carry neutral labels. Levee says it has no relationship with them.

## Banned

Universal (enforced by `tools/design-check.mjs`): gradients, gradient or clipped text, default indigo and violet, glows, blur panels, default typefaces, em dashes, emoji, arrow glyphs welded to links, tracked all-caps eyebrows, 01/02/03 markers, scroll and attention motion, count-ups, filler copy, placeholder people, round unsourced numbers.

Product-specific:

- Claims no table backs: never, guaranteed, trustless, within seconds.
- The retired design and its words: river sections, staff gauges, hydrographs, flood drills, water fills, flood stage, action stage, freeboard, crest. Barlow, Old Standard and italic labels. A 5:7 hero with an instrument on the right.
- Red as an accent: a red line, red text, a red pill or a red dot. Red is the page or nothing.
- Health pills in green, amber and red, gauge dials, sparklines, KPI tiles, icon cards.
- A dark theme.
- Sponsor colours: NEAR green, Aave lilac, Hyperliquid mint, Base blue, Arbitrum blue.
- Small framed Live or Simulation tags. The word goes at the start of a sentence.
- A third-party address named or linked as an example of anything negative.
- Presenting the order as likelihood.

## Checks

- `pnpm --filter web test`, `typecheck` and `design-check` pass.
- Screenshots at 390 and 1440 of the home page, a report, the last 5%, a debt Levee cannot repay and `/proof`, compared with the mock. Spot checks at 375, 820 and 1920 for overflow.
- Keyboard: skip link, address box, Read it, links, the fall slider and the term fields, with a visible focus ring on white and on red.
- Reduced motion: the numbers jump.
