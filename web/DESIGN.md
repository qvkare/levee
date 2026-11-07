# Levee design direction

A borrower's position is a river section on a printed hydrographic sheet, and the water level is their own number. Read this before adding a page or a component. If the work needs something this document does not allow, change the document first and give the reason. `pnpm --filter web design-check` enforces the bans below.

Lentic (`lentic.qvkare.com`) is the sibling this follows, by the owner's decision of 7 Nov 2026: its structure and its discipline, not its code, palette or drawing. No component here is copied from it.

## Product world

- **Does:** repays a borrower's Aave debt from a reserve when their health factor crosses a trigger they set. The position stays in the borrower's wallet, and the keeper cannot send funds anywhere else. The public tool reads any address with no wallet and no login.
- **First ten seconds:** a judge, a screener or a borrower wants to see how close a position is to liquidation, what a rescue does about it, and whether the numbers are real.
- **Proof data:** the stage of a real position, read from Aave at a stated block, so anyone can repeat the read with a direct call.
- **Worst moment:** a position over flood stage (health factor below 1.00). The water goes over the levee crest and across the land behind it, and a liquidator takes collateral plus a bonus.
- **Never confuse:** read and protected (the tool only reads); live and simulated; cross and isolated; a market fall and a fall relative to debt; missing data and zero.
- **Name:** a levee is the bank that holds a river back from the land behind it.

## Neighbours surveyed

Viewport screenshots at 1280 px, 7 Nov 2026.

| Site | Signature element | Display type and weight | Colours | Real data |
|---|---|---|---|---|
| near.org | Sparkling star field on black | FK Grotesk 400, 80 px | Black, green | None on the first screen |
| near-intents.org | Centred card over a checker pattern | System sans, 600 | Warm grey, orange | None |
| aave.com | Phone mockups on a lilac wash | Aave Repro 550, 72 px | White, lilac | Illustrative balance in a mockup |
| defisaver.com | Gradient headline over a dashboard screenshot | DM Sans 600, 60 px | Near-black, teal to blue gradient | Static screenshot |
| hyperliquid.xyz | Light serif headline, mint particle field | Teodor 300, 64 px | Pale grey, mint, deep green | None on the first screen |
| check-for-flooding.service.gov.uk | Height, trend and state as plain large text | GDS Transport 700, 48 px | White, government blue | Live river level |
| water.noaa.gov | Hydrograph with coloured flood-category bands (the surveyed gauge URL returned 404; known from prior use) | Proxima Nova 400 | Blue with category colours | Live stage |
| lentic.qvkare.com (sibling) | Staff gauge and flood drill beside a light claim | Barlow 300, 72 px | Survey white, lake green, one flood red | Live reading, marked simulations |

Bulwark has no public site at the URL tried. It was reviewed from source.

Shared baseline: light display type, one brand colour, a screenshot or mockup as the proof.

Nobody does: show a rescue. The DeFi sites show pictures of dashboards, and the flood services print real levels as text and leave the river out. Levee runs a real position through the fall, with and without a rescue, on its own river section.

## Concept

The position is a river section. Health factor is stage, liquidation is flood stage, and the reserve is the levee.

Water rises as health falls, because that is what danger looks like on a river. So the staff reads downwards: 1.00 sits at the crest and larger values sit lower.

| Product fact | Visual |
|---|---|
| Health factor | River stage, read off a staff gauge |
| Health factor 1.00, or margin ratio 1.00 | Flood stage: the levee crest, and the only magenta line |
| Approximate fall to liquidation | Freeboard: the height between water and crest |
| Trigger and target | Dashed lines on the section. The water rises to one and a repay draws it down to the other |
| Reserve | The levee: a buff bank with protected land behind it |
| No debt and no positions | Dry channel: water sits on the bed |
| Health factor below 1.00 | Water over the crest and across the land, with only the levee's outline left |
| How a rescue works (home page) | The flood drill: a real position walked down in simulated rounds, with and without Levee |
| What a position would do | Try a position: the same section and the same maths, under the reader's own sliders |
| What a stolen key can do | A ruled table of attempts, each refused with the contract's rule in words |
| A source that did not answer | Gauge out of service: hatching, and a sentence naming the source. A blank is never drawn as zero |
| Isolated Hyperliquid position | Row labelled "Not covered" in words |

The staff is spaced by the square root of the fall, as a rating curve is drawn on log paper. The last few percent above flood stage get the most room, which is where a reader needs resolution. Both faces mark the same height: stage on one, approximate fall on the other, as a real staff can carry feet and metres.

Tests:

- **Portability: pass.** A river section with a flood line only makes sense for a product that holds water back from a line.
- **Data: pass.** The water, every reading and every repay come from a position's own terms. The drill states the block it read.
- **Failure: pass.** Over flood stage has its own drawing, not a red badge. Liquidation shows what was taken.
- **Squint: pass.** At 20% it is a blue band, a buff bank and one magenta line beside a light claim. No neighbour looks like that, and Lentic's staff stands in green water with no bank.
- **Explainability: pass.** "Water rises as health falls. At 1.00 it reaches the crest."

## Palette

One light theme. The hues are those of a nautical chart: white deep water, blue shoal, buff land, black ink, magenta caution.

| Name | Hex | Role |
|---|---|---|
| Paper | `#FCFDFC` | Page and air above the water |
| Ink | `#101A22` | Text, staff marks, waterline, bed, primary buttons |
| Ink 2 | `#44525D` | Secondary text and table headers |
| Rule | `#C6CED1` | Hairlines between rows and sections |
| Water | `#BFDFF0` | Water, and nothing else |
| Land | `#EFDCA4` | The levee and the land behind it, and nothing else |
| Flood | `#9C0B66` | Flood stage, and anything at or past it |

Colour means: blue is water, buff is land, and magenta is flood stage. Being healthy is the normal state and is drawn in ink, so a safe position is not painted as a reward. Action stage is ink too, and is told in words and by the water's height.

Measured contrast (WCAG ratio): ink on paper 17.3, ink 2 on paper 7.9, ink on water 12.6, ink 2 on water 5.8, ink on land 13.0, ink 2 on land 5.9, flood on paper 7.8, flood on water 5.7, flood on land 5.8.

## Type

- **Barlow:** interface, body and tables at 400 and 500, the claim and section headlines at 300. Its reference is public infrastructure lettering: plates, highway signs, bridges. A levee is public works.
- **Barlow Condensed:** staff numerals at 500 and large readings at 400, so long figures fit a narrow column.
- **Old Standard italic, 17 px and up:** names and measures on the water (readings, trigger, target). On charts and USGS sheets, water features are lettered in italic and land in roman. This rule is the reason the face is here, and it appears nowhere else. The wordmark stays roman, because a levee is land.
- **System monospace:** addresses, hashes and code only.
- **Figures:** tabular everywhere numbers align or update.

Fonts are self-hosted from `app/fonts` under the SIL Open Font License, so the build has no font network dependency.

## Mark

An L, chosen by the owner on 7 Nov 2026. The tall arm is held water and the short arm is protected land, split by a slanted cut, the bank. It is one colour: ink on paper, pale steel on dark.

It is set left of the wordmark at about 28 px in the header, and it heads the README. `public/levee-mark.svg` is the ink mark. `public/levee-mark-profile.svg` is the pale mark on its dark field, for social and Open Graph images, and it is the only dark thing in the product. The favicon and the Open Graph image are rendered from these two files. If the mark changes, render them again.

Do not recolour it to the palette, add effects, or redraw it inside pages.

## Layout

- **Alignment and grid:** left aligned to one margin, 1180 px at most.
- **Home page:** a 5:7 split with no stock hero. Left: the claim, one paragraph, the address box and example addresses. Right: the flood drill. Stacked below 960 px. Then, separated by rules: Try a position, How a rescue runs, What each key can do, Limits, Proof. No logo strip, no icon cards, no statistic row, no closing banner.
- **Section heads:** the headline left and one short lede right, on the same 5:7 grid.
- **Report page:** the verdict, then the full-bleed section, then one ruled station per venue.
- **Separation:** 1 px rules and space. The river bed closes each section drawing, so nothing floats. There are no cards.
- **Tables:** real `table` elements for flood stages, steps, attempts, trust, failures, positions and runs. Below 720 px long rows stack; short tables stay tables.
- **Radius per role:** inputs and buttons 2 px, like a stamped plate. The state tag 2 px. Everything else 0.
- Print feel comes from rules and lettering only. No paper grain, folds or textures.

## Components

- **Buttons:** ink fill for the one primary action, ink outline for secondary ones. Links are underlined text.
- **Navigation:** one sticky bar, 64 px, opaque paper with a hairline under it (no blur, no shadow). The mark and wordmark, then the sections. Below 980 px the sections move into a Menu of ruled rows, built on `details`, so it works without scripts.
- **Inputs:** 1 px ink border on paper with a visible label. Errors appear under the field in words, tied with `aria-describedby`.
- **State tags:** "Live" or "Simulation", a small ruled tag. It is the only badge on the site, because it is a state. Anything not read from a chain carries "Simulation".
- **Status:** stage names in words, not pills. Magenta only for flood stage. A status always has text, not colour alone.
- **Figures:** a ruled row replaces stat boxes.
- **Hop strip:** three ruled cells under the drill: Detected, Contract signs, Repay lands. A hairline ring fills in ink as each hop passes. Timings read "not yet measured" until real runs exist. No latency is invented.
- **Simulator controls:** range inputs with a 1 px ink track and a paper thumb with an ink ring. The value and its unit are printed beside each control, never inside the thumb.
- **Segmented control:** With Levee and Without Levee, ruled, ink fill on the chosen one.
- **Empty, loading and error states:** empty is a dry channel with the reason. While a report loads, the page stays put and the button says "Reading the gauges". There is no skeleton, because a report is rendered in full on the server: a reader without scripts, or a screener fetching the URL, gets every number in the first response. A failed source is a gauge out of service, says which source and that the figures are missing, not zero. Nothing that needs a reading (slider, repay sentence, target line) appears without one.

## Motion

Nothing fades or slides in on scroll, and no number counts up. What moves is the product's own simulation.

- **The water line** settles at each new reading in 220 ms (`cubic-bezier(0.2, 0, 0, 1)`, transform only).
- **The flood drill**, the home page's one orchestrated moment. It plays once on load and again on Replay or on a branch button. It starts from a real public Aave position read at a stated block, or a marked example if the read fails, then steps the collateral price down in simulated rounds, one reading every 160 ms, for about twelve seconds in all, and stays on the final state. With Levee, the water rises to the trigger, the hop strip fills, the repay lands and the water drops to the target. Without Levee, the same path goes over flood stage and a liquidator takes collateral plus the bonus. Every number comes from the position's terms, and every simulated reading is labelled simulated.
- **Try a position** follows input directly. The water moves in 220 ms.
- **The report's target line** slides in 180 ms and stops at the levee, because a water level cannot pass through land.
- **Reduced motion:** nothing plays. The drill becomes a table of its states, and the sliders jump.

## Voice

- **Headlines:** "Repay your Aave debt before a liquidator does." "Water rises as health falls." "No live runs yet."
- **Error message:** "Base RPC did not answer. Base figures are missing, not zero."
- **Words we use:** stage, flood stage, action stage, freeboard, repay, reserve, trigger, target, caps, gauge, hop, approximate, simulated, unaudited.
- **Honesty:** anything not built is tagged "Simulation" and says what exists today. Timings are not invented. Failure conditions are published.
- **Words we avoid:** protect (unless a rescue actually ran), safe, secure, risk-free, "never", "trustless", "guaranteed", "within seconds" (spec section 8), and the universal list.

## Banned

Universal: section 4 of the portfolio `DESIGN.md`.

Product-specific:

- Em dashes.
- Waves, ripples, droplets and water textures. The water is one flat tint with a straight line on top.
- Green, amber or red health pills. A river has no traffic light.
- Count-ups and scroll reveals.
- Fake statistics, invented latency and unsourced figures.
- Icon cards, rounded cards, dashboard tiles, KPI rows, sparklines and gauge dials. The one instrument is the staff.
- Sponsor colours: NEAR green, Aave lilac, Hyperliquid mint, Base blue and Arbitrum blue. They would read as an official property.
- Blue gradients of any kind.
- A dark theme: a survey sheet is printed, and one theme keeps the colour meanings legible.
- Hazard stripes. Hatching means a gauge is out of service, nothing else.
- Illustrated levees that do not move with data, other than the fixed profile of the section itself.

## Checks

- `pnpm --filter web design-check` passes.
- Screenshots at 375, 820 and 1280 px with real data, including the drill's flood ending, reduced motion and a gauge out of service.
