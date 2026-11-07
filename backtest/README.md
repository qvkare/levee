# Levee backtest

Replays real Aave v3 liquidations on Base and Arbitrum against a simulated Levee position, and publishes the misses.

**The question.** For borrowers liquidated in real crash windows, how many would a Levee position have saved, at what reserve size and rescue delay, and how much liquidation bonus would they have avoided?

**The answer** is in [`results/summary.md`](results/summary.md), with every number in `results/summary.json`. Read the limits below before quoting anything.

Everything here is read-only. It uses no keys and no funds, and no rescue in it has happened. A "saved" position is a simulation result.

## Findings

From 7,495 `LiquidationCall` events and $57.9M of liquidated debt: 5,977 positions, of which 5,008 are in scope and 969 excluded. These findings hold for the model below and nothing wider. Unless stated otherwise: T 1.20, G 1.50, D 60 s.

1. **Reserve size is the main limit.** The saved share is 36% at R 10% of debt, 60% at 20%, 85% at 30% and 95% at 50%. At R 30%, 612 of the 745 misses ran out of reserve, and 22 lost the race. The median position needed 15% of debt and the 90th percentile 31%, so the saved share climbs steeply up to about R 30% and then flattens. Do not quote one reserve size alone.
2. **Delay matters in a fast crash and hardly at all in a slow one.** Among positions armed above T, at R 30%, the 2025 window saved 60% at 10 s and 54% at 300 s on Arbitrum, and 74% and 58% on Base. The 2026 window saved 98% to 99% at every delay.
3. **A low trigger is where the race is.** At T 1.05, R 30%, `too_slow` rises from 25 positions at 10 s to 324 at 300 s. A higher trigger loses fewer races because it fires earlier. It would also fire on positions that recover, and those false alarms are not measured here, because every position in this sample was liquidated.
4. **Many borrowers were already thin.** When the window opened, 54% of in-scope positions were below HF 1.20, 23% below 1.10 and 7% below 1.05. A trigger above current HF is an upfront repay, not a rescue. The results separate these: at R 30%, 2,102 of the 2,295 positions armed above 1.20 were saved (91.6%), and 165 of the 193 misses among them were in the 2025 window.
5. **Plain collateral is a serious rival.** The same USDC supplied to Aave at the start, with no keeper, survives 30%, 51%, 69% and 96% at R 10%, 20%, 30% and 50%, against 36%, 60%, 85% and 95% for Levee. Levee's whole survival edge is that a repaid dollar does 1.28 times the work of a dollar of collateral, and only if it lands first. At R 50% the edge is gone, mostly because mixed debt runs out of USDC to repay.
6. **Volatile alt collateral is out of reach.** On Arbitrum in the 2025 window, all 99 positions that needed over 50% of debt had ARB, AAVE or LINK as their largest collateral. The median need was 7% for WETH and 5% for WBTC. Repaying 50% at once still left 115 of 588 positions there liquidated.
7. **Some moves give no warning.** On 2025-10-10 the AAVE feed on Base updated every 30 s or so and fell up to 19.3% in one update, taking positions from HF 1.07 to below 1 in a single block. No trigger can react to a price the oracle has not published. At T 1.05, six positions had no observation below T before the liquidation block.
8. **Bonus avoided:** $2.42M of the $2.80M at risk at R 30%, and $1.06M, $1.41M, $1.91M and $2.62M at R 5%, 10%, 20% and 50%. Collateral avoids $2.14M at R 30%. Most of this is on a few large positions: 144 positions of $100k or more carry $1.85M of the amount at risk.

## Run

```sh
pnpm install
pnpm backtest    # from the repo root. Offline, reads data/derived, writes results/
```

`pnpm backtest` makes no network calls and is deterministic: a re-run gives byte-identical results.

```sh
pnpm --filter @levee/backtest test       # simulation tests, including a hand-worked case
pnpm --filter @levee/backtest typecheck
pnpm --filter @levee/backtest fetch-data # rebuilds data/raw and data/derived from the chain
```

`fetch-data` needs no key. It took about 90 minutes on free endpoints, with rate limits, and it resumes where it stopped. Raw responses are about 170 MB and git-ignored. The committed files in `data/derived` are enough to reproduce every result.

To add a window, add it to `WINDOWS` in `src/config.ts` and run `fetch-data`.

## Scope

| Item | Value |
|---|---|
| Windows | 2025-10-10 to 2025-10-11 and 2026-01-31 to 2026-02-06, UTC. These match the two events a rival project backtested |
| Pools | Aave v3 Pool on Base and Arbitrum, as listed in `docs/SPEC.md` section 3 |
| Block ranges | Pinned in `data/derived/blocks.json` |
| Position | One borrower on one chain in one window. Its race is against its first `LiquidationCall` in that window |
| In scope | Holds native USDC variable debt at the block before that first liquidation. Decided by token address, because USDC.e on Arbitrum also has the symbol USDC |
| Mixed debt | Stays in scope, with repays capped at the USDC share. Reported separately |
| Excluded | No native USDC debt. `results/summary.md` lists how many and why |

## Data sources

Measured on 2026-11-07. Free public endpoints change, and any of these may stop working.

| Need | Source | Result |
|---|---|---|
| Logs, Base | Tenderly public gateway, Sentio public RPC | Worked at 1,000 blocks per query. Identical on every window |
| | Pocket Network gateway | **Dropped 321 of 3,225 logs with no error.** Its logs were a strict subset. Every log it missed was confirmed from the transaction receipt |
| Logs, Arbitrum | Tenderly public gateway, `arb1.arbitrum.io` | Worked at 20,000 blocks per query. Identical on every window |
| Archive `eth_call`, Base | `mainnet.base.org`, Tenderly, Sentio, thirdweb, Merkle, Nodies, dRPC | Worked, with rate limits |
| Archive `eth_call`, Arbitrum | Blast public, Pocket Network, Tenderly, Sentio, thirdweb, Nodies | Worked, with rate limits |
| Did not work | Envio HyperSync | `/height` is open, but `/query` returns 401 without a token |
| | PublicNode | Archive reads need a token |
| | 1RPC, `arb1.arbitrum.io` | No state at these blocks for `eth_call` |
| | Pocket Network on Base | State pruned for `eth_call` |

Archive access exists, so health factor comes from the protocol itself. The fallback of rebuilding it from reserve data was not needed before a liquidation. It is used only after one, as described below.

## Method

**1. Liquidations.** Every `LiquidationCall` on both Pools in the pinned block ranges, from at least two providers per chain. Any log one provider left out is kept only if its transaction receipt confirms it.

**2. Path to liquidation.** `getUserAccountData(user)` at archive blocks, through Multicall3. HF moves only when an oracle updates or the user acts, so sampling follows the oracle. Every Chainlink `AnswerUpdated` behind AaveOracle was collected, then:

- Coarse: every 15 minutes from the window start to the first liquidation.
- Fine: at every update of the feeds behind the position's own assets, plus the block before the liquidation. This runs from the last coarse point with HF at or above 1.4, for at most the last two hours.

Dips earlier than that keep 15-minute resolution. In the fine part, time resolution is one oracle update.

The committed paths are thinned to keep the file small. The first and last observations stay, as does every observation that crosses a trigger in the grid, every debt change of 0.2% or more, and otherwise a point each time HF moves 0.15% (3% above HF 1.4). Kept points are a subset of the observations, so thinning can delay a detection but cannot bring one forward.

**3. After the first liquidation.** The real position has changed, so nothing can be observed. The counterfactual freezes the portfolio from the block before the liquidation and marks it to AaveOracle at every later update of its assets, to the end of the window. These paths are rebuilt from committed portfolios and price series at run time, then thinned to moves of 0.25% with every low kept. Validation below gives the error of this method.

**4. Rescue.** For each trigger T, target G, reserve R and delay D:

- The position is armed at the window start, or at its first observed debt if opened later.
- The reserve is R × debt at arming. It does not grow if the borrower borrows more. Debt grew by over 50% after arming on 23 positions and shrank by over a third on 81.
- The keeper checks each observation. If HF is below T, no repay is in flight, the cooldown has passed and reserve remains, it sends `min(debt - capacity / G, reserve left, USDC debt left)`. That is the formula in `docs/SPEC.md` section 5, which writes the target as T. Here T is the trigger and G the target. Capacity is collateral × liquidation threshold. The amount is sized on the state at detection.
- The repay lands D seconds later and lowers debt from the next observation on. A tie with the liquidation block goes to the liquidator.

**5. Saved.** A position is saved only if a repay landed before the real liquidation and HF stays at or above 1 at every point from that liquidation to the end of the window. If nothing landed first, the position is the real one, and the real one was liquidated.

**6. Bonus.** Aave pays the liquidator `debt covered × (bonus - 1)` in extra collateral, and the protocol keeps a share of that. "Bonus" here is the gross figure the borrower lost, using the eMode bonus where one applies. Only the first episode counts, meaning liquidations less than an hour apart, because a later one may be a position the owner rebuilt.

**7. The fair comparison.** The same dollars with no keeper:

- *Hold as collateral:* the reserve is supplied to Aave as USDC at arming and adds `reserve × LT` of capacity.
- *Repay at arming:* the reserve repays USDC debt at once. This bounds any rescue of that size.

Both use the same survival rule as the rescue.

## Assumptions

1. **The infrastructure works.** Keeper, RPCs, NEAR and the MPC network all work through the worst minutes of the event, with a fixed delay D.
2. **D is a constant, not a measurement.** No rescue has run end to end. The 10 s row is an estimate for float already on the lending chain. The research notes put an off-venue route at 60 to 180 s, also not measured.
3. **Detection is free of lag beyond D.** The keeper sees each observation at that block's time. D must cover polling, the two-RPC agreement in the spec, NEAR, MPC, broadcast and inclusion.
4. **The cooldown is 60 s.** The spec leaves it to the owner. `results/summary.md` shows the sensitivity.
5. **Caps do not bind.** `max_per_rescue` and `max_per_day` are taken as at least the reserve.
6. **One repay at a time.** The next can fire only after the last has landed, as in the spec's loop.
7. **USDC is worth $1 in a repay.** The oracle read 0.999 to 1.008 in these windows, so the error is under 1%, and it peaked on 2025-10-10.
8. **Interest is ignored** on repaid debt and in the frozen portfolio. Over days it is small next to the price moves.
9. **The borrower does nothing different.** Real actions before the liquidation stay in the path, even if the real borrower took them because of low HF. After the liquidation the portfolio is frozen.
10. **Rescues do not move the market.** Fewer liquidations would mean less forced selling, which is not modelled, and it would help.
11. **The real liquidator's timing is taken as given.** HF below 1 before that block is not fatal on its own, because no liquidator acted on the real position then.
12. **Mixed debt keeps its USDC share** from the block before the liquidation.
13. **Reserve costs are not modelled:** no yield forgone, gas, NEAR fees or MPC fees. The supply yield of the collateral baseline is left out too.
14. **Parameters are read at the window start.** Thresholds, bonuses and eMode come from `data/derived/markets.json`.

## Failure conditions

| Condition | In this backtest |
|---|---|
| A liquidator wins the race | Modelled: `too_slow` and `no_warning` |
| Reserve empty | Modelled: `reserve_empty` |
| Route slow | Modelled only as a fixed D. A slower route shows up in the higher-D rows |
| Follow-up repay late | Modelled: `follow_up_too_slow` |
| USDC debt runs out on a mixed position | Modelled: `usdc_debt_exhausted` |
| MPC down | **Not modelled.** Every position would be missed |
| Keeper down, or RPCs disagree under load | **Not modelled.** The spec acts only if two RPCs agree within 0.5%, which may fail in a crash |
| Sequencer or NEAR congestion | **Not modelled** beyond D |
| Gas above the contract's fee ceiling | **Not modelled** |

## Limits

- **Only liquidated positions are in the sample.** Borrowers who crossed T and recovered are not here, so false alarms are not measured. A real reserve also sits idle or gets spent on positions that would have survived anyway. Do not read bonus avoided as a return on all reserves held.
- **Saved does not mean better off.** A saved position still holds the fallen collateral. Bonus avoided is what is measured, not the outcome of holding through the crash.
- **Arming at the window start is a choice.** A borrower below T at arming gets a repay at once, which is an upfront repay and not a rescue. Results separate these.
- **Counts are dominated by small positions.** 2,539 of the 5,008 in-scope positions owed under $1k, where a rescue is hard to justify, and 144 positions of $100k or more carry two thirds of the bonus at risk. Results are split by size.
- **Two events, two chains, one protocol.** Both events are crashes, and other crashes may run faster or slower.

## Validation

`results/summary.md` has the full table.

| Check | Result |
|---|---|
| Log sets across providers | Two complete providers agree on every window. All 321 logs Pocket Network dropped are confirmed by transaction receipt |
| About 2.26M archive reads: a sample re-read on the other providers | 54,394 comparisons on 12 endpoints, 0 mismatches |
| Frozen-portfolio HF against `getUserAccountData`, block before each liquidation | Worst error 0.031% across 5,008 positions |
| Same, across the last two hours | 96.9% of positions within 0.5%. A larger gap means the portfolio changed in the run-up, and those points use the observed path anyway |
| Frozen HF below 1 at the liquidation block, as Aave requires | 5,005 of 5,008. The other three owed under $100 and were below 1 a block earlier, and the price rose within the liquidation block |
| Collateral seized against the configured bonus, which checks prices, eMode and decoding together | Median error near zero, n = 5,852 |
| Independent re-implementation of the headline cell | Same 4,263 saved and the same bonus to the dollar, using every price update with no thinning |

To run the last check: `python3 backtest/scripts/verify_headline.py`. It shares no code with the TypeScript and takes a few minutes.

Tests cover the simulation, including a hand-worked position written out in `test/simulate.test.ts`, as well as scope, thinning, frozen paths and aggregation.

## Hyperliquid

`results/hyperliquid.md` is a separate reference table for 2025-10-10, from `ConejoCapital/HyperMultiAssetedADL` at a pinned commit and hash. It holds liquidation fills only, with no survivors, account margin, mark prices or timing. So it supports reserve arithmetic and a table conditional on liquidation, not a survival rate and not a rescue result. It stays out of every Aave number.

## Layout

| Path | Contents |
|---|---|
| `src/sim` | The rescue model and baselines. Pure functions |
| `src/report` | Aggregation and Markdown |
| `src/fetch` | Network steps, one file per stage |
| `src/derive.ts` | Raw data to compact committed files, and validation |
| `src/frozen.ts` | Post-liquidation paths from portfolios and prices |
| `src/run.ts` | `pnpm backtest` |
| `data/derived` | Committed inputs to the run |
| `data/raw` | Raw responses, git-ignored |
| `results` | Outputs, committed |
