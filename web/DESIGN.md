# Levee design direction

One sentence: a borrower's position is a river cross-section, printed like a hydrographic sheet, and the water level is their own live number. Read this before adding a page or a component. If the work needs something this document does not allow, change the document first and give the reason.

Process and universal bans come from the portfolio `DESIGN.md`, section 2 and section 4. `tools/design-check.mjs` is the automated half.

## Product world

- Does: Levee repays a borrower's Aave debt from a reserve when their health factor crosses a trigger they set. The public tool reads any address with no wallet and no login.
- First ten seconds: a judge, a screener or a borrower pastes an address and must see how close it is to liquidation, on which venue, and what it would take to step back.
- Proof data: the live stage of an address, read from Aave pools and the Hyperliquid info API, with the block number so anyone can repeat the read.
- Worst moment: a position over flood stage (health factor below 1.00). The water goes over the levee crest and across the land behind it. The one alarm colour names the state in words.
- Never confuse: read and protected (this tool only reads); cross and isolated; a market fall and a fall relative to debt; missing data and zero.
- Name: a levee is the bank that holds a river back from the land behind it.

## Neighbours surveyed

Viewport screenshots at 1280 px, 2026-11-07.

| Site | Signature element | Display type and weight | Colours | Real data |
|---|---|---|---|---|
| near.org | Sparkling star field on black | FK Grotesk 400, 80 px | Black, green | None on the first screen |
| near-intents.org | Centred card over a checker pattern | System sans, 600 | Warm grey, orange | None |
| aave.com | Phone mockups on a lilac wash | Aave Repro 550, 72 px | White, lilac | Illustrative balance in a mockup |
| defisaver.com | Gradient headline over a dashboard screenshot | DM Sans 600, 60 px | Near-black, teal to blue gradient | Static screenshot |
| hyperliquid.xyz | Light serif headline, mint particle field | Teodor 300, 64 px | Pale grey, mint, deep green | None on the first screen |
| check-for-flooding.service.gov.uk | Height, trend and state as plain large text | GDS Transport 700, 48 px | White, government blue | Live river level |
| water.noaa.gov | Hydrograph with coloured flood-category bands (the surveyed gauge URL returned 404; known from prior use) | Proxima Nova 400 | Blue with category colours | Live stage |

Bulwark has no public site at the URL tried. It was reviewed from source.

Shared baseline: display type at 300 to 600, one brand colour, rounded cards, a dashboard screenshot or mockup as the proof.

Nobody does: draw the reader's own number as a physical level. The DeFi sites show pictures of dashboards. The flood services have real levels, but print them as text and leave the river out. Levee takes that gap: the first screen is a cross-section whose water level is real, next to the input that changes it.

## Concept

The position is a river section. Health factor is stage, liquidation is flood stage, and the reserve is the levee.

Water rises as health falls, because that is what danger looks like on a river. So the staff reads downwards: 1.00 sits at the crest and larger values sit lower.

| Product fact | Visual |
|---|---|
| Health factor | River stage, read off a staff gauge |
| Health factor 1.00, or margin ratio 1.00 | Flood stage: the levee crest, and the only magenta line |
| Approximate fall to liquidation | Freeboard: the height between water and crest |
| Chosen target | Dashed line on the staff. The repay figure is what draws the water down to it |
| Reserve | The levee: a buff bank with protected land behind it |
| No debt and no positions | Dry channel: water sits on the bed |
| Health factor below 1.00 | Water over the crest and across the land, with only the levee's outline left |
| A source that did not answer | Gauge out of service: the reading is struck through with hatching and says why. A blank is never drawn as zero |
| Isolated Hyperliquid position | Row labelled "Not covered" in words |

The staff is spaced by the square root of the fall, as a rating curve is drawn on log paper. The last few percent above flood stage get the most room, which is where a reader needs resolution. Both faces mark the same height: stage on one, approximate fall on the other, as a real staff can carry feet and metres.

Tests:

- Portability: pass. A river section with a flood line only makes sense for a product that holds water back from a line.
- Data: pass. The water line, every reading and the target line come from the live read.
- Failure: pass. Over flood stage has its own drawing, not a red badge.
- Squint: pass. At 20% zoom it is a blue band, a buff bank and one magenta line. No neighbour looks like that.
- Explainability: pass. "Water rises as health falls. At 1.00 it reaches the crest."

## Palette

The hues are those of a nautical chart: white deep water, blue shoal, buff land, black ink, magenta caution. Dark mode is the same chart on an ECDIS night palette, not an inverted page.

| Name | Day | Night | Role |
|---|---|---|---|
| `--paper` | `#FCFDFC` | `#0D161B` | Page and air above the water |
| `--ink` | `#101A22` | `#E6EDEF` | Text, staff marks, waterline, bed |
| `--ink-2` | `#44525D` | `#A3B3BB` | Secondary text and table headers |
| `--rule` | `#C6CED1` | `#2E3C44` | Hairlines between table rows and sections |
| `--water` | `#BFDFF0` | `#17405A` | Water, and nothing else |
| `--land` | `#EFDCA4` | `#4B4126` | The levee and the land behind it, and nothing else |
| `--flood` | `#9C0B66` | `#FF8ACD` | Flood stage line, and anything at or past it |

Colour means: blue is water, buff is land, and magenta is flood stage. There is no green, amber or red, so a safe position is not painted as a reward. Action stage is told in words and by the water's height.

Measured contrast (WCAG ratio): ink on paper 17.3 and 15.4, ink-2 on paper 7.9 and 8.5, ink on water 12.6 and 9.2, ink-2 on water 5.8 and 5.1, ink on land 13.0 and 8.5, ink-2 on land 5.9 and 4.7, flood on paper 7.8 and 8.5, flood on water 5.7 and 5.1, flood on land 5.8 and 4.7. Day first, night second.

## Type

- Barlow: interface, body, tables and numerals, weights 400 and 500. Its reference is public infrastructure lettering: plates, highway signs, bridges. A levee is public works. Display sizes stay at 500.
- Barlow Condensed 500: staff numerals and tight table columns, so a flood-stage table stays readable at 375 px.
- Old Standard italic, 400, 17 px and up: names and measures on the water (station readings, the target line, stage names in the section). On charts and USGS sheets, water features are lettered in italic and land in roman. This rule is the reason the face is here. It appears nowhere else.
- System monospace: addresses, hashes and code only.
- Figures: tabular everywhere numbers align or update.

Fonts are self-hosted from `app/fonts` under the SIL Open Font License, so the build has no font network dependency.

## Layout

- Alignment and grid: left aligned to one margin. The section chart is the only full-bleed element. Text stays near 68 characters.
- How sections are separated: 1 px rules and space. The river bed closes the chart, so nothing floats.
- Where tables replace cards: everywhere. Flood-stage bands, trust model, failure conditions, positions and runs are all tables. There are no cards.
- Radius per role: inputs and buttons 2 px, like a stamped plate. Everything else 0.
- Print feel comes from rules and lettering only. No paper grain, folds or textures.

## Components

- Buttons: ink plate with paper text, 2 px radius. One primary per screen. Hover inverts to outline, focus shows a 2 px ink ring with offset, disabled drops to `--ink-2`.
- Inputs: 1 px ink border on paper with a visible label. Errors appear under the field in words, tied with `aria-describedby`.
- Status: stage names in words. Magenta only for flood stage. A status always has text, not colour alone.
- Tables: real `table` elements with captions and header scopes. At phone width long tables reflow to stacked rows and keep explicit ARIA roles. Short tables stay tables.
- Empty, loading and error states: empty is a dry channel with the reason. While a report loads, the current page stays put and the button says "Reading the gauges". There is no skeleton, because the report is rendered in full on the server: a reader without scripts, or a screener fetching the URL, gets every number in the first response. A failed source is a gauge out of service, says which source and that the figures are missing, not zero. Nothing that needs a reading (slider, repay sentence, target line) appears without one.

## Motion

- The target line slides 180 ms with a cubic-bezier when the reader moves the target, using transform only. This shows cause and effect. It stops at the levee, because a water level cannot pass through land.
- Nothing moves on scroll or on load.
- With `prefers-reduced-motion` all transitions are removed.

## Voice

- Headlines: "Levee repays your Aave debt from a reserve when your health factor crosses a trigger you set." / "Stage report for 0x1234…abcd" / "No live runs yet."
- Error message: "Base RPC did not answer in time. Base figures are missing, not zero."
- Words we use: stage, flood stage, action stage, freeboard, repay, reserve, trigger, caps, gauge, approximate, unaudited.
- Words we avoid: protect (unless a rescue actually ran), safe, secure, "never", "trustless", "guaranteed", "within seconds" (spec section 8), and any phrase in the universal copy ban.

## Banned

Universal: section 4 of the portfolio `DESIGN.md`.

Product-specific:

- Green, amber or red status colours. A river has no traffic light.
- Dashboard tiles, KPI rows, sparklines and gauge dials. The one instrument is the staff.
- Waves, ripples, droplets and water icons. The water is a flat tint with a straight line on top.
- Blue gradients of any kind.
- Mint, lilac and near-black with bright green: those belong to Hyperliquid, Aave and NEAR.
- Rounded cards. Illustrated levees that do not move with data, other than the fixed profile of the section itself.
- Hazard stripes. Hatching means a gauge is out of service, nothing else.

## Checks

- `pnpm --filter web design-check` passes.
- Screenshots at 375, 820 and 1280 px, day and night, with real data and the failure state.
