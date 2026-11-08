# Levee backtest

Replays real Aave v3 liquidations on Base and Arbitrum against a simulated Levee position, and publishes the misses.

**The question.** For borrowers liquidated in real crash windows, how many would a Levee position have saved, at what reserve size and rescue delay, and how much liquidation bonus would they have avoided?

**The answer** is in [`results/summary.md`](results/summary.md), with every number in `results/summary.json`. Read the limits below before quoting anything.

**A second question.** Why would a borrower not simply repay the same USDC upfront? [`results/portfolio.md`](results/portfolio.md) and `results/portfolio.json` answer it over every native USDC borrower on both pools, liquidated or not, with one reserve shared across two chains, in a calm month as well as the two crashes, and with the interest the reserve costs.

Everything here is read-only. It uses no keys and no funds, and no rescue in it has happened. A "saved" position is a simulation result.

## Findings

From 7,495 `LiquidationCall` events and $57.9M of liquidated debt: 5,977 positions, of which 5,008 are in scope and 969 excluded. These findings hold for the model below and nothing wider. Unless stated otherwise: T 1.20, G 1.50, D 60 s.

1. **Reserve size is the main limit.** The saved share is 36% at R 10% of debt, 60% at 20%, 85% at 30% and 95% at 50%. At R 30%, 612 of the 745 misses ran out of reserve, and 22 lost the race. The median position needed 15% of debt and the 90th percentile 31%, so the saved share climbs steeply up to about R 30% and then flattens. Do not quote one reserve size alone.
2. **Delay matters in a fast crash and hardly at all in a slow one.** Among positions armed above T, at R 30%, the 2025 window saved 60% at 10 s and 54% at 300 s on Arbitrum, and 74% and 58% on Base. The 2026 window saved 98% to 99% at every delay.
3. **A low trigger is where the race is.** At T 1.05, R 30%, `too_slow` rises from 25 positions at 10 s to 324 at 300 s. A higher trigger loses fewer races because it fires earlier. It would also fire on positions that recover. Those false alarms are not in this sample, because every position in it was liquidated. Finding 9 measures them over the whole population.
4. **Many borrowers were already thin.** When the window opened, 54% of in-scope positions were below HF 1.20, 23% below 1.10 and 7% below 1.05. A trigger above current HF is an upfront repay, not a rescue. The results separate these: at R 30%, 2,102 of the 2,295 positions armed above 1.20 were saved (91.6%), and 165 of the 193 misses among them were in the 2025 window.
5. **Plain collateral is a serious rival.** The same USDC supplied to Aave at the start, with no keeper, survives 30%, 51%, 69% and 96% at R 10%, 20%, 30% and 50%, against 36%, 60%, 85% and 95% for Levee. Levee's whole survival edge is that a repaid dollar does 1.28 times the work of a dollar of collateral, and only if it lands first. At R 50% the edge is gone, mostly because mixed debt runs out of USDC to repay.
6. **Volatile alt collateral is out of reach.** On Arbitrum in the 2025 window, all 99 positions that needed over 50% of debt had ARB, AAVE or LINK as their largest collateral. The median need was 7% for WETH and 5% for WBTC. Repaying 50% at once still left 115 of 588 positions there liquidated.
7. **Some moves give no warning.** On 2025-10-10 the AAVE feed on Base updated every 30 s or so and fell up to 19.3% in one update, taking positions from HF 1.07 to below 1 in a single block. No trigger can react to a price the oracle has not published. At T 1.05, six positions had no observation below T before the liquidation block.
8. **Bonus avoided:** $2.42M of the $2.80M at risk at R 30%, and $1.06M, $1.41M, $1.91M and $2.62M at R 5%, 10%, 20% and 50%. Only $0.67M of the $2.42M is on positions armed above T, so most of it is an upfront repay rather than a race won. Collateral avoids $2.14M at R 30%. Most of the money sits on a few large positions: 144 positions of $100k or more carry $1.85M of the amount at risk.

### Why not repay upfront?

**For one position, the data say: repay upfront.** Across every address with native USDC debt on both pools, about 50,000 to 58,000 a period, the same 30% of debt repaid at arming saved at least as many liquidated positions as Levee once Levee's repay is counted the same way (731 against 720 in the 2025-10 crash, 3,541 against 3,541 in 2026-02, 191 against 189 in a calm month), avoided the same gross bonus to within 1%, and costs nothing to hold. Levee's reserve, idle with the rescuer as the spec has it today, costs the USDC borrow APR against that repay: $48 per $1,000 a year on Arbitrum and $57 on Base, averaged over 2025-01 to 2026-11. Each crash returned $5.50 (2025-10) and $6.44 (2026-02) of bonus avoided per $1,000 held, so it would take 8 to 10 such crashes a year to pay for a year of carry, and an upfront repay would have avoided that bonus anyway. What Levee does differently is spend less: members armed above T drew 13% of their reserve in the 2025-10 crash, 25% in 2026-02 and 9% in the calm month, and 74%, 84% and 99.5% of everything drawn went to members that survived anyway. That keeps the borrower's leverage, which is worth something only if the borrowed USDC earns more than it costs. This backtest does not measure that. Sharing one reserve across a borrower's Base and Arbitrum positions did not change the answer at R 30%, and at smaller R it saved more positions without reliably avoiding more bonus.

Unless stated: T 1.20, G 1.50, R 30%, D 60 s. Details in [`results/portfolio.md`](results/portfolio.md).

9. **Triggers fire mostly on positions that recover.** Of members armed above T 1.20 that later crossed it, 67% in 2025-10, 72% in 2026-02 and 97% in the calm month were neither liquidated nor ever below HF 1 on their path. A lower trigger fires less: at T 1.05 the false-alarm share was 27%, 32% and 80%. In the calm month, 7% of members armed above T 1.20 crossed it.
10. **Where the reserve goes.** Over the whole population, Levee drew $44.0M of $206.6M held in 2025-10 (21%), $89.1M of $200.3M in 2026-02 (44%) and $31.6M of $177.7M in the calm month (18%), including members armed below T, whose repay fires at once. Members that were not liquidated drew $32.5M, $74.9M and $31.4M of that.
11. **Levee saves no position upfront does not, counted the same way.** Uncapped, as the pre-registered rule counts it, Levee saved 16 positions in 2026-02 that upfront lost, and none the other way (3,557 against 3,541). In 2025-10 it saved 3 that upfront lost and lost 11 that upfront saved. 17 of those 19 Levee-only saves are borrowers outside the headline set that repaid all their USDC themselves before they were liquidated, and 2 are mixed-debt headline positions whose fixed USDC share of a falling total debt dropped below what Levee had repaid. In each, the rule counts Levee's repay against debt that was no longer there. With the repay capped at the USDC debt left, as upfront is, Levee's saves are a subset of upfront's, and a test holds that on random paths.
12. **Carry against bonus.** The USDC borrow APR was 4.83% on Arbitrum and 5.67% on Base. Holding the population's reserve idle cost $74.9k over the two days of the 2025-10 window, $185.6k over the seven of 2026-02, and $747.7k over the calm month, against $1.14M, $1.29M and $25.8k of bonus avoided. A smaller reserve does more per dollar: at R 5% the break-even is 2.4 and 5.7 crashes a year. A reserve earning the USDC supply APR, which the spec does not do, would cost $15 to $16 per $1,000 a year, and 2.5 to 2.9 crashes a year would pay for it at R 30%.
13. **Real two-chain borrowers exist, but few are liquidated.** 1,951, 1,978 and 2,007 addresses held USDC debt on both chains at the start of each period. 119 of them had a position liquidated in 2025-10 and 318 in 2026-02, so no synthetic pairs were needed.
14. **Sharing one reserve.** At R 30% a shared reserve saved 111 of 144 liquidated positions in the real pairs in 2025-10, against 114 for the same budget repaid upfront and 113 for two separate reserves, and 398, 399 and 400 of 430 in 2026-02. Bonus avoided was the same to within $150. At R 5% sharing saved more (54 against 41, and 122 against 89) but in 2025-10 avoided less bonus, $239k against $319k: two Base positions of $1.7M each lost the whole budget to a larger Arbitrum partner that was liquidated anyway. First come, first served gives the reserve to whichever position falls first, not to the one it can save. With a 300 s route, the off-venue reserve that sharing across chains needs, it saved 106 instead of 111 in 2025-10.
15. **Validation.** Rebuilt HF matches `getUserAccountData` at every read with $1 or more of debt to a worst error of 0.06%, and at a seeded sample of 7,856 member and block pairs to 0.024%. On the headline positions' committed direct reads, 100.0% are within 0.5%. Below $1 of debt, Aave's 8-decimal base currency moves HF by whole percents, so dust is left out of the error figures, not out of the results. An independent Python re-implementation reproduces the population figures.

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

`fetch-data` needs no key. The headline steps took about 90 minutes on free endpoints, with rate limits, and the population steps about four hours more. It resumes where it stopped. Raw responses are about 2.5 GB and git-ignored. The committed files in `data/derived` are enough to reproduce every result. `pnpm --filter @levee/backtest derive-portfolio` rebuilds the population files from `data/raw` alone.

To add a window, add it to `WINDOWS` in `src/config.ts` and run `fetch-data`.

## Scope

| Item | Value |
|---|---|
| Windows | 2025-10-10 to 2025-10-11 and 2026-01-31 to 2026-02-06, UTC. These match the two events a rival project backtested |
| Pools | Aave v3 Pool on Base and Arbitrum, as listed in `docs/SPEC.md` section 3 |
| Block ranges | Pinned in `data/derived/blocks.json` |
| Position | One borrower on one chain in one window. Its race is against its first `LiquidationCall` in that window |
| In scope | Holds native USDC variable debt at the block before that first liquidation. Decided by token address, because USDC.e on Arbitrum also has the symbol USDC |
| Mixed debt | Under 99% USDC. Stays in scope, with repays capped at the USDC share. Reported separately |
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

Added on 2026-11-08 for the population parts:

| Need | Source | Result |
|---|---|---|
| Every USDC `Borrow` since listing, Base | Tenderly public gateway (both hostnames), Sentio public RPC | 1,000 blocks per query: 33,575 queries, about 30 minutes |
| | thirdweb | Also 1,000 blocks. Not used |
| | dRPC, Nodies | Refused on the free plan: dRPC by range, Nodies above 50 blocks |
| Every USDC `Borrow` since listing, Arbitrum | Tenderly public gateway, `arb1.arbitrum.io` | Accepted 1,000,000 blocks per query with a topic filter |
| | Blast public | 10 blocks per query for logs. Not used for logs |
| Action times | Tenderly public gateway | Returns `blockTimestamp` on every log, so actions are placed in time with no extra reads |
| Hyperliquid account history | `api.hyperliquid.xyz/info` | `clearinghouseState` is the current state only. `portfolio` returns an account-value history with no margin. The `hyperliquid-archive` S3 bucket answers 403 without AWS credentials. No free historical source of account margin was found |

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

## Method: population, shared reserve, calm period and carry

These parts ask why a borrower would not simply repay the same USDC upfront. For one position, an upfront repay of the same size is the bound for any rescue, so the possible reasons are elsewhere: a reserve that is not spent, a reserve shared across positions, or what holding it costs. This section was written and committed before any Levee result for these parts was computed. Results go to `results/portfolio.md` and `results/portfolio.json`. Nothing here changes `results/summary.json` or `results/summary.md`.

**Periods.** The two crash windows above, and one calm period chosen by the rule below.

**Calm-period rule.** Read the AaveOracle WETH price on Base at the first block of each UTC day from 2025-01-01 to 2026-11-01. Base makes one block every 2 seconds, so that block is `(midnight - 1686789347) / 2` exactly. A day's move is the absolute change from one midnight price to the next. Take the longest run of consecutive days whose moves are all at or below 8%, and on a tie the earliest. The calm period is the 30 days at the centre of that run: it starts `floor((run length - 30) / 2)` days after the run starts. Both chains use the same 30 days.

**Population.** For each pool and period, every address with native USDC variable debt at the period's first block, plus every address that borrows native USDC during the period. Candidates come from every `Borrow` event with native USDC as the reserve since USDC was listed on that pool (block 8,242,475 on Base and 106,410,714 on Arbitrum). Each candidate's balance of USDC's variable debt token is read at the first block. The sum of those balances is checked against the token's `totalSupply` at the same block, which shows any borrower the scan missed. There is no floor on size. Results are split by size.

**Path of a population member.** Liquidated positions in the headline set keep the paths they have in `results/summary.json`. Every other member gets a path from the frozen-portfolio method with re-reads:

- The full portfolio, `getUserReserveData` for every reserve plus the eMode, is read at the period's first block. A newcomer's is read at the first re-read after its first USDC borrow, and it is armed there.
- Every Pool `Supply`, `Withdraw`, `Borrow`, `Repay`, `LiquidationCall`, `ReserveUsedAsCollateralEnabled`, `ReserveUsedAsCollateralDisabled`, `UserEModeSet` and `DeficitCreated` that names the address, and every aToken `BalanceTransfer` from or to it, is an action.
- Re-reads follow a time grid: every 60 s in the crash windows and every 300 s in the calm period. At each grid point, every member that acted since the last one has the reserves it touched and its eMode read again. The new state applies from its last action in that interval. Between its first and last action in one interval, the old state stands.
- Balances are kept as scaled balances and grown with each reserve's liquidity and variable borrow index, read every hour and interpolated in time, so interest moves the path.
- HF is computed at every AaveOracle price update of the member's assets and at every re-read, with thresholds and eMode categories read at the period's first block.
- A member liquidated in the period also has its full portfolio read at the block before its first liquidation. From that liquidation on, the portfolio is frozen and marked to the oracle, as in the headline method.

**Outcomes per trigger.** T runs over the existing grid, with G 1.50, R 30% of debt at arming, D 60 s and a 60 s cooldown unless stated. The keeper rule is Method step 4, except that the USDC cap uses the USDC debt on the path at that point instead of a fixed share.

- Crossed T: HF below T at any point after arming. Members armed below T are counted apart, as in the headline.
- Needed: liquidated in the period, with no Levee. False alarm: crossed T, not liquidated, and HF never below 1 on the path. HF below 1 on the path without a liquidation is a column of its own, because it is either a path error or a position too small to be worth liquidating.
- Reserve held: R × debt at arming, for every member. Reserve drawn: repays that landed. Both are summed over the population. Reserve drawn by members that were not liquidated is shown on its own: those would have survived anyway.
- In the calm period, the same figures per member per 30 days.

**Shared reserve.**

- Real pairs: addresses with native USDC debt on both Base and Arbitrum at a period's first block. Their count is reported for each period.
- A pair's budget is B = R × the sum of both debts at arming. It is used three ways:
  - (a) One Levee reserve B for both. The keeper rule runs over both paths in time order. Whichever position is below T takes what the rule asks for, first come, first served, until B is gone. Each position has its own repay in flight and its own cooldown, because the spec gives each position its own rescuer.
  - (b) B repaid upfront at arming, split by debt at arming.
  - (c) Two Levee reserves, split by debt at arming.
- Outcomes: positions saved, addresses with both positions saved, and gross bonus avoided. Saved has the headline meaning. A position that was not liquidated in reality counts as saved under all three.
- The spec cannot share one reserve across two chains today: each position's reserve sits with its own rescuer on its own chain. Sharing needs the off-venue reserve, whose route time is not measured. So (a) is shown at D 60 s and again at D 300 s.

**Synthetic pairs.** Added for a window if fewer than 50 real pairs in that window hold a position liquidated in it. They are labelled synthetic in every table, and come after the real pairs.

- Anchors: every liquidated position in the headline set in that window, in id order.
- Partner: a member of the other chain's population in the same window whose debt at arming is from half to twice the anchor's, at a different address. One uniform draw per anchor, with replacement, in anchor order, from a Mulberry32 generator seeded with 20261108. An anchor with no candidate is skipped and counted.
- Two versions bracket how often both positions fall together. "Independent" draws the partner from the whole population. "Both liquidated" draws it only from liquidated positions in the headline set.

**Carry.** `getReserveData(USDC)` on both pools, every hour in each period and once a day from 2025-01-01 to 2026-11-01: `currentVariableBorrowRate` and `currentLiquidityRate`, which are APRs.

- The spec today: the reserve sits idle as USDC with the rescuer. Holding R instead of repaying it costs R × the USDC borrow APR a year.
- A hypothetical, not in the spec: a reserve that earns the USDC supply APR costs R × (borrow APR - supply APR).
- Both are shown per $1,000 of reserve per year. No crash frequency is estimated from two windows. Instead, for each crash: bonus avoided per dollar of reserve held, and how many such crashes a year would pay for a year of carry.

**Validation.**

- The `totalSupply` check above.
- `getUserAccountData` at a seeded sample of member and block pairs in every period, against the rebuilt path: 200 random blocks per chain and period, with 5 random members at each block and 5 members whose rebuilt HF there is between 1.0 and 1.4.
- For liquidated positions in the headline set, the rebuilt path against the direct reads already committed.

Hyperliquid stays out of these parts. Its only source here has no account states over time.

### Implementation notes

Added after the method above was committed. They fix details it left open and change no rule.

- The calm rule's Base block, `(midnight - 1686789347) / 2`, is rounded up: the first block at or after midnight, one second after it.
- The re-read grid is counted in blocks: 30 and 150 blocks on Base, 240 and 1,200 on Arbitrum, which averaged 0.249 s a block in both windows.
- A grid re-read covers the reserves named in the member's actions since its last read, plus its eMode. The reads at the start, at a newcomer's first read and before a first liquidation cover every reserve.
- Balances are scaled by the indexes read in the same call, and grown with the hourly indexes between reads.
- A newcomer is armed at its first read that shows USDC debt. An account that borrowed and repaid USDC between two grid points is never seen with debt and is left out.
- A liquidation before a member was armed does not count.
- A member liquidated outside the headline set has its gross bonus worked out as in the headline: first episode, eMode bonus where it applies, prices from the period's price file.
- Reserve drawn counts every repay sent, including one still in flight when the period ends.
- Thinning for the simulation keeps, below 1.30, every read, every crossing of 1.0 or a trigger, every low, and a point each time HF moves 0.15% or debt 0.2%. At or above 1.30, the highest trigger, the keeper never acts, so points there are left out, and runs of 256 price rows where a bound on HF stays at or above 1.30 are not evaluated at all. A test holds the results to those of a run that evaluates every row.
- The synthetic draws use a fresh generator, seeded 20261108, for each window and each version.

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
13. **Reserve costs are not modelled in `summary.md`:** no yield forgone, gas, NEAR fees or MPC fees. The supply yield of the collateral baseline is left out too. `portfolio.md` adds the interest forgone; gas and fees stay out everywhere.
14. **Parameters are read at the window start.** Thresholds, bonuses and eMode come from `data/derived/markets.json`.
15. **The collateral baseline can always supply USDC.** It uses USDC's normal threshold of 0.78 and ignores supply caps, isolation mode and any eMode that would exclude USDC. The reserve is USDC, so the baseline does not fall with the crash. A reserve held in the position's own asset would do worse.

For the population, shared-reserve, calm-period and carry parts, in addition:

16. **Every member has Levee, with the same T and R.** Real borrowers would choose their own, and many would set T below their HF at arming.
17. **A member keeps doing what it really did.** Its actions stay on the path, including repays it made because HF was low, and Levee's repays come on top. So a member that saved itself counts as a false alarm, which is what Levee would have spent on it.
18. **A member that was not liquidated survives with Levee too.** A repay only raises HF.
19. **The pre-registered rule takes a landed repay off total debt for good**, as the headline model does. If the borrower later repaid its USDC itself, that counts the same dollars twice. `portfolio.md` shows the effect with the repay capped at the USDC debt still on the path, which is how the upfront bound counts it.
20. **Between an action and the next grid read, the old portfolio stands.** That is up to 60 s in the crash windows and 300 s in the calm period. Validation measures the error.
21. **Interest follows hourly indexes,** interpolated in time. Thresholds and eMode are read at each period's first block.
22. **One reserve for two chains repays on either chain within D.** That needs the off-venue reserve, which is not built and whose route time is not measured.
23. **Carry is the USDC APR as a simple yearly rate.** An idle reserve earns nothing, as in the spec today. A drawn reserve stops costing carry; that is ignored, which overstates carry by at most the share drawn.
24. **Synthetic pairs set how often both positions fall together by construction.** The two versions bracket it. Only real pairs say where it actually sits.

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

- **Only liquidated positions are in the headline sample.** Borrowers who crossed T and recovered are not in `summary.md`, so false alarms are not measured there. Do not read its bonus avoided as a return on all reserves held. `portfolio.md` measures both over the whole population.
- **Saved does not mean better off.** A saved position still holds the fallen collateral. Bonus avoided is what is measured, not the outcome of holding through the crash.
- **Arming at the window start is a choice.** A borrower below T at arming gets a repay at once, which is an upfront repay and not a rescue. Results separate these.
- **Counts are dominated by small positions.** 2,539 of the 5,008 in-scope positions owed under $1k, where a rescue is hard to justify, and 144 positions of $100k or more carry two thirds of the bonus at risk. Results are split by size.
- **Two events, two chains, one protocol.** Both events are crashes, and other crashes may run faster or slower.

For the population parts:

- **Two crashes and one calm month.** That is too little to estimate how often crashes come, so carry is shown as break-evens, not as a yearly return. The calm month is December 2025 and includes the holidays.
- **The value of keeping leverage is not measured.** Levee's one measured advantage over upfront is that it leaves most of the reserve unspent, so the borrower keeps its debt. That is worth something only if the borrowed USDC earns more than the borrow APR, and nothing here measures that. An upfront repay can also be borrowed again, which costs gas and is not modelled either.
- **Counts are dominated by dust.** About half the members owed under $100, and most members with HF below 1 that were never liquidated are among them. Dollar figures are not affected. `portfolio.md` splits results by size.
- **The shared-reserve results rest on few liquidations.** About 2,000 real addresses held USDC debt on both chains in each period, but only 144 liquidated positions in 2025-10 and 430 in 2026-02 sit in them, and a handful of large positions move the bonus figures. A shared reserve across chains also needs the off-venue reserve, which is not built.
- **Arming every member at the period start, with the same T and R.** About 7% to 14% of members were below T 1.20 at the start. Their repay fires at once, as an upfront repay would. Results show the share drawn by members armed above T apart.
- **The borrow scan may have missed a few dollars of debt.** On Base, members' USDC debt at each period start fell short of the debt token's `totalSupply` by $4.61 to $4.70, out of $230M to $345M, which is at most a few tiny borrowers. On Arbitrum the gap was $0.11.
- **The re-read grid.** Between an action and the next grid read, a member's old portfolio stands, for up to 60 s in a crash and 300 s in the calm month. The random validation sample rarely lands in such a gap, so it bounds this error only loosely. The headline positions' direct reads, which cover the run-up to each liquidation, agree to 0.5% at 100.0% of points.

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

For the population parts, `results/portfolio.md` has the full tables.

| Check | Result |
|---|---|
| Members' USDC debt against the debt token's `totalSupply`, at each period start | Base short by $4.61 to $4.70 of $230M to $345M. Arbitrum short by $0.11 |
| Rebuilt HF against `getUserAccountData` at every read, members with $1 or more of debt | 344,928 reads in six chain-periods. Worst error 0.059%, all within 0.5%. With dust included, 98.8% to 99.96% within 0.5% |
| The same against a seeded sample: 200 random blocks per chain and period, 5 random members and 5 rebuilt at HF 1.0 to 1.4 at each | 7,856 reads with $1 or more of debt. Worst error 0.024%. Rebuilt and direct HF on the same side of every trigger in every read |
| Rebuilt paths of headline positions against their committed direct reads | 1.24M points, 100.0% within 0.5%. Median 0.002% |
| Skipping rows above the highest trigger, and thinning | `test/skip.test.ts`: on Arbitrum 2025-10, the same keeper outcomes as a run that evaluates every row |
| Independent re-implementation of the population figures and the real-pair shared reserve | Every period and chain at T 1.20, R 30%: the same members, liquidations, saves by Levee and by upfront, crossings, false alarms and bonus to the dollar, and reserve held and drawn within $20, with no thinning. The same 111 of 144 and 398 of 430 liquidated positions saved by a shared reserve in the real pairs |

To run it: `python3 backtest/scripts/verify_portfolio.py [--period 2025-10|2026-02|calm]`. It shares no code with the TypeScript, rebuilds every member's path from the committed files, runs the keeper rule on every point with no thinning, and checks the T 1.20, R 30% row of every period and chain. Counts and bonus must match exactly, and dollar sums within 0.5%. It takes about 25 minutes for all three periods.

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
| `src/sim/tracked.ts` | The keeper rule on population paths, and on several paths sharing one reserve |
| `src/portfolio` | Population files, path rebuild, aggregation and Markdown for `portfolio.md` |
| `src/calm.ts` | The calm-period rule |
| `data/derived` | Committed inputs to the run |
| `data/derived/portfolio` | Population files per chain and period, calm-period prices and markets, the validation sample |
| `data/derived/daily.json`, `calm.json` | Daily WETH price and USDC rates, and the calm period the rule picked |
| `data/raw` | Raw responses, git-ignored |
| `results` | Outputs, committed |
