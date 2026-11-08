# Levee backtest

Replays real Aave v3 liquidations on Base and Arbitrum against a simulated Levee position, and publishes the misses.

**The question.** For borrowers liquidated in real crash windows, how many would a Levee position have saved, at what reserve size and rescue delay, and how much liquidation bonus would they have avoided?

**The answer** is in [`results/summary.md`](results/summary.md), with every number in `results/summary.json`. Read the limits below before quoting anything.

**A second question.** Why would a borrower not simply repay the same USDC upfront? [`results/portfolio.md`](results/portfolio.md) and `results/portfolio.json` answer it over every native USDC borrower on both pools, liquidated or not, with one reserve shared across two chains, in a calm month as well as the two crashes, and with the interest the reserve costs.

**A third question.** With no reserve at all, does selling just enough of the borrower's own collateral to repay, as `docs/SPEC.md` section 9 proposes, beat doing nothing, by how much, and what does it cost on false alarms? [`results/collateral.md`](results/collateral.md) and `results/collateral.json` answer it on the same borrowers and paths, with a real Uniswap v3 quote at every unwind's landing block.

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

### Repay from collateral

**Against doing nothing, collateral mode paid for itself in both crashes and lost money in the calm month. It protected less than the same USDC repaid upfront, and needs no cash.** At T 1.20 and a 100 bps cap, over every native USDC borrower on both pools, it avoided $781k of liquidation bonus in the 2025-10 crash, $1.07M in 2026-02 and $22k in the calm month, and paid $606k, $298k and $144k in swap costs and gas. The net was +$175k, +$774k and −$122k, or $0.25, $1.16 and −$0.21 per $1,000 of debt. It pays on positions of about $10k of debt and up in both crashes. It is not worth it on small positions, at a 300 bps cap, or as a cost that runs in quiet months, and the 2025-10 figure rests on two things that flatter or hurt it: pools that had not caught up with the oracle, and a gas spike on Arbitrum. Details in [`results/collateral.md`](results/collateral.md).

Unless stated: T 1.20, G 1.50, D 60 s, cooldown 60 s, the cheapest usable fee tier at each unwind, a 100 bps cap. Every figure is for one borrower acting alone; no one else sells into the same pools.

16. **One line per period.** Across 49,685 borrowers in the 2025-10 crash, collateral mode avoided $781k of liquidation bonus and paid $89k in swap costs, of which $56k on borrowers who were not liquidated anyway, and $517k in gas. Across 54,479 in 2026-02: $1.07M avoided, $279k in swap costs, $199k of it on borrowers not liquidated, and $18k in gas. Across 58,170 in the calm month: $22k avoided, $134k in swap costs, almost all on borrowers not liquidated, and $9k in gas.
17. **It saves fewer positions than a reserve or an upfront repay.** Of liquidated members it saved 635 of 952 in 2025-10, 3,424 of 4,077 in 2026-02 and 114 of 229 in the calm month, against 720, 3,541 and 189 for the reserve at R 30% counted the same way, and 731, 3,541 and 191 for the same USDC repaid upfront. It avoided 69%, 83% and 83% of the bonus upfront avoided. On the 5,008 liquidated positions of `summary.md` it saved 4,059 and avoided $1.85M of $2.80M, against 4,263 and $2.42M for the reserve and 4,272 and $2.42M upfront. As for the reserve, most saves are positions armed below T, whose unwind fires at once: in 2025-10, 416 of the 635, and $700k of the $781k avoided.
18. **Where it misses: thin pools and late follow-ups.** In 2025-10, 128 liquidated positions failed after an unwind reverted on the cap or for lack of liquidity, and 114 because the next unwind was late. Uniswap v3 against native USDC could not take LINK, ARB, AAVE or wstETH in size, or the largest WBTC positions: 3 WBTC positions with $7.3M of debt and $214k of bonus at risk failed this way in 2025-10, and 4 cbBTC positions with $6.0M and $125k on Base in 2026-02. Collateral with no usable pool at all (wstETH, weETH, ezETH, wrsETH and LBTC on Base, and others) left 7.7% to 9.3% of members `no_pool`; on Base in 2026-02 that was $130M of $380M of debt, though only $10k of bonus at risk among those liquidated there.
19. **Swap cost is about 15 to 35 bps a dollar at the 100 bps cap, and double at 300.** Dollar-weighted against AaveOracle at the landing block: 15 bps in 2025-10, 33 bps in 2026-02 and 34 bps in the calm month, and 62 to 67 bps at 300 bps. The median unwind cost −3 to 10 bps; the cost sits in the large unwinds.
20. **Gas was the largest cost in the 2025-10 crash.** Arbitrum's base fee reached 41 gwei during it, up to $88 for one 600,000-gas unwind. 63% of the $517k of gas was paid by unwinds that reverted: a position too large for its pool retries every minute (assumption 28). With no gas on reverts, which bounds what a keeper that checked a quote before sending could save, the 2025-10 net would be $502k. In 2026-02 and the calm month gas was $18k and $9k.
21. **Some 2025-10 unwinds sold into stale pools.** Uniswap v3 pools for AAVE and ARB on Arbitrum priced their asset up to about 50% above a falling AaveOracle, and the unwinds that sold there were paid more than the oracle. Counting every unwind at no better than the oracle raises the 2025-10 swap cost from $89k to $181k and halves the net to $83k. In 2026-02 the same correction moves the net from $774k to $744k.
22. **False alarms.** Of members armed above T that crossed it and were never liquidated or below HF 1, 2,137 of 3,502 in 2025-10, 5,965 of 8,556 in 2026-02 and 2,378 of 3,580 in the calm month had an unwind land. They paid $46, $17 and $23 each in swap cost and gas, and sold 19%, 16% and 23% of their collateral, with a median of 27%, 25% and 29% per borrower that unwound: deleveraging they did not need. In the calm month, members armed above T paid $1.60 each in swap cost and gas over the 30 days, and sold 2.0% of their collateral. Of the calm month's $134k of swap cost, $78k was false alarms and $57k members armed below T, which unwind at once.
23. **Small positions lose.** In 2025-10 the net was −$313k on positions under $10k of debt, mostly gas, and +$487k on the larger ones. In 2026-02, when gas was cheap, every band above $100 was positive. In the calm month the $100k-and-up band, which had no liquidations, paid $118k in swap costs.
24. **A 300 bps cap buys little and costs a lot.** It saved 19, 123 and 0 more positions and avoided $220k, $69k and $0 more bonus, but its swap cost was $378k, $377k and $174k higher, most of it on borrowers not liquidated, so the net was lower in every period: +$78k, +$473k and −$290k.
25. **Fixing the fee tier changes little.** Using only the tier with the most USDC, as the spec's `pool_fee` would, saved 628 instead of 635 in 2025-10 and 3,418 instead of 3,424 in 2026-02, and raised swap cost by $12k and $30k.
26. **Validation.** The quotes are real: every header, oracle price, pool price and quote of 500 sampled landing blocks per chain, read again on another endpoint, agreed, 55,516 values in all. Real swaps that were the first event of their pool in a landing block match a quote for the same USDC at the block before to a median of 0.0000 bps, with 539 of 543 within 0.1 bps. The ladder line changed 1 of 1,631 sampled cap decisions at 100 bps and 6 at 300 bps. Of 1,000 repeat reverts per chain taken without a quote, 13 on Base and 6 on Arbitrum would have landed. The independent Python check reproduces the T 1.20 rows of every period and chain.

## Run

```sh
pnpm install
pnpm backtest    # from the repo root. Offline, reads data/derived, writes results/
```

`pnpm backtest` makes no network calls and is deterministic: a re-run gives byte-identical results. It takes about 5 minutes and 1.5 GB of memory, most of it for the population and collateral-mode parts.

```sh
pnpm --filter @levee/backtest test       # simulation tests, including a hand-worked case
pnpm --filter @levee/backtest typecheck
pnpm --filter @levee/backtest fetch-data # rebuilds data/raw and data/derived from the chain
```

`fetch-data` needs no key. The headline steps took about 90 minutes on free endpoints, with rate limits, the population steps about four hours more, and the collateral-mode quotes about two hours more. It resumes where it stopped. Raw responses are about 2.5 GB and git-ignored. The committed files in `data/derived` are enough to reproduce every result. `pnpm --filter @levee/backtest derive-portfolio` rebuilds the population files from `data/raw` alone.

To add a window, add it to `WINDOWS` in `src/config.ts` and run `fetch-data`.

The repay-from-collateral steps run at the end of `fetch-data`, or alone:

```sh
pnpm --filter @levee/backtest fetch-pools      # usable Uniswap v3 pools at each period start
pnpm --filter @levee/backtest fetch-quotes     # quotes at every landing block, in rounds; resumes [--chain base|arbitrum] [--period 2025-10|2026-02|calm]
pnpm --filter @levee/backtest validate-quotes  # ladder error, second endpoint, real swaps, repeat reverts
python3 backtest/scripts/verify_collateral.py  # independent check of the collateral-mode headline
```

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

Added on 2026-11-08 for repay from collateral:

| Need | Source | Result |
|---|---|---|
| Uniswap v3 quotes, oracle prices and headers at landing blocks, Base | `mainnet.base.org`, Tenderly (both hostnames), thirdweb, Nodies, dRPC, Blast public | Worked, with rate limits. Every call is a Multicall3 `eth_call` of up to 60 quotes |
| | Sentio | Caps `eth_call` at 10M gas, too little for a batch of quotes. Not used |
| | `base.merkle.io` | Now answers "pruned history unavailable" below block 51,000,000. Not used |
| | 1RPC, BlockPI, PublicNode, Ankr | Pruned, down, or need a token or key |
| Same, Arbitrum | Pocket Network, Blast public, Tenderly (both hostnames), thirdweb, Nodies | Worked, with tight rate limits: this was the slowest step |
| | Sentio | 10M gas cap, as on Base. Not used |
| | dRPC, 1RPC, OnFinality, Ankr, PublicNode, ZAN | No state at these blocks, or need a token or key |
| Swap logs in landing blocks, for validation | Tenderly public gateway, `mainnet.base.org`, `arb1.arbitrum.io` | Worked. Pocket Network is not used for logs |

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

## Method: repay from collateral

This part asks whether the mode in `docs/SPEC.md` section 9 beats doing nothing, by how much, and what it costs on false alarms. It was written and committed before any collateral-mode code existed or any collateral-mode result was computed. Results go to `results/collateral.md` and `results/collateral.json`. Nothing here changes `summary.*`, `portfolio.*` or `hyperliquid.*`.

**The mode.** There is no reserve. When HF is below T, the keeper sends one unwind. In one transaction it sells just enough of one collateral asset on a Uniswap v3 pool against native USDC to receive R USDC, and repays R of the borrower's USDC debt. The unwind lands D seconds after detection, as a repay does in the reserve mode, and the swap executes at the landing block.

**Uniswap v3.** Factory `0x33128a8fC17869897dcE68Ed026d694621f6FDfD` and QuoterV2 `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a` on Base, factory `0x1F98431c8aD98523631AE4a59f267346ea31F984` and QuoterV2 `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` on Arbitrum. On 2026-11-08 each QuoterV2's `factory()` returned the factory listed with it. Fee tiers 100, 500, 3000 and 10000. Only pools directly against native USDC count, with no route through a third token.

**Usable pools.** Read at each period's first block, on each chain. For every reserve with a liquidation threshold above zero other than native USDC, and every fee tier, take the pool from `getPool`. A tier is usable if the pool exists and `quoteExactOutputSingle` for 1,000 USDC out succeeds at no more than 300 bps worse than AaveOracle at that block. An asset is usable if at least one tier is. The list holds for the whole period. An asset's configured tier is its usable tier whose pool held the most native USDC at that block.

**Which collateral to sell.** At arming, from the portfolio in force then, rank the position's collateral (enabled as collateral, a threshold above zero under its eMode, not native USDC) by oracle value. The position sells the largest usable one, and keeps it for the whole period, as the spec fixes it at `register`. A tie goes to the asset listed first in the period's price file. A position with no usable collateral is `no_pool` and never unwinds.

**Sizing.** The keeper rule is the tracked rule in Method step 4 and the population section: it checks each observation, keeps one unwind in flight, waits 60 s from its last send, and sizes on the state at detection. At a detection point with capacity CL and debt D, both net of earlier unwinds, and the sold asset's threshold L_c:

```
R = (G × D − CL) / (G − L_c × (1 + s))
```

as in `docs/SPEC.md` section 9, with s the configured tier's fee plus `max_slippage_bps`. R is capped by the USDC debt left and by the collateral left: `R × (1 + s) / price` may not exceed the units of the asset on the path less the units already sold. An unwind is sent only if R is at least $1. Without that floor, interest on a fully repaid USDC debt makes the keeper send a few cents every cooldown, each paying gas.

**Landing block.** On Base, the first block at or after the landing time t: `ceil((t − 1686789347) / 2)`. On Arbitrum, interpolated linearly in time between the nearest rows of the period's price file before and after t, and rounded up; beyond the last row, extrapolated at the period's mean block time. The header of each landing block is read, and its time against t is reported.

**Quotes.** At each landing block, one Multicall3 `eth_call` reads `QuoterV2.quoteExactOutputSingle(asset, USDC, amount, fee, 0)` on every usable tier of the asset, AaveOracle's price of the asset, of USDC and of WETH, and each pool's `slot0`. One block serves many unwinds of different sizes, from different triggers, targets and slippage settings, so quotes are taken at fixed amounts, 10^(k/8) USDC for k from 0 to 64, and an amount between two of them is priced on the straight line between their quotes. In an exact-output swap the collateral paid is convex in the USDC received, so the line can overstate the cost but not understate it. Where the upper amount cannot be filled, the amount itself is quoted. Every landing block that any simulated unwind needs is quoted; nothing is sampled except the validation below. Raw responses are git-ignored, and a compact derived file is committed.

**Which tier.** The main result takes the cheapest usable tier at each unwind. A sensitivity uses only the configured tier, as the spec's fixed `pool_fee` would.

**The slippage cap.** `max_in = R × price(USDC) / price(asset) × (1 + max_slippage_bps / 10000)`, at AaveOracle's prices in the landing block, as the helper computes it. If the quote needs more than `max_in`, or no tier can fill R, the unwind reverts: nothing moves and gas is paid. The keeper tries again at its next observation below T once the cooldown has passed, sized again. The grid is 100 and 300 bps.

**Effects of a landed unwind.** Debt falls by R. As in the capped rule of the population section, a landed amount counts only up to the USDC debt still on the path, because the uncapped rule counts a borrower's own later repays twice. Units sold accumulate. At every later point, capacity falls by the units sold, capped at the units of that asset on the path, times its oracle price and threshold at that point. So the sold collateral keeps falling in value after it is sold, as it would have in the portfolio.

**Saved and the reasons for a miss.** A position is saved under the rule in Method step 5. For a liquidated position that is not saved, the first of these that holds: `no_pool`; `no_warning`, HF never below T before the liquidation block; `slippage_cap`, an unwind reverted on the cap or for lack of liquidity before the position failed; `too_slow`, nothing landed before the liquidation; `collateral_exhausted`, the chosen asset was all sold or an unwind was cut by what was left; `usdc_debt_exhausted`; `follow_up_too_slow`.

**Costs.** Swap cost, per landed unwind: the collateral paid at AaveOracle's price minus the USDC received at AaveOracle's price, both at the landing block. It is negative when the pool pays more than the oracle. It is split into the gap between the pool's price before the swap and the oracle, and the fee and price impact. Gas, per unwind sent, landed or reverted: 600,000 gas, the top of the spec's estimate, at the landing block's base fee and AaveOracle's WETH price, with no priority fee. The L1 data fee and the NEAR fees, about 13 Tgas a rescue, are left out. Net benefit is gross bonus avoided minus swap cost minus gas, shown per position and per $1,000 of debt at arming.

**Paths.** Collateral-mode runs use every observation, with no thinning. A population member's path has a point at every price update of its assets and every read, from arming to the period end, frozen after a liquidation as before. A headline position keeps its committed observations and then has its frozen portfolio at every price update after the liquidation. A member that is not liquidated and never falls below 1.30, the highest trigger, cannot unwind at any T, and is counted without being simulated. The units and threshold of the sold asset come from the member's rebuilt reads, and after a liquidation from the frozen portfolio.

**Grid.** The population, in all three periods: every T, G 1.50, D 60 s, cooldown 60 s, both slippage settings, cheapest tier; and T 1.20 with the configured tier. Liquidated positions in the headline set: every T, G and D in the existing grid with T below G, both slippage settings, cooldown 60 s; and cooldowns of 0, 10, 60 and 300 s at T 1.20, G 1.50, D 60 s. The headline cell is T 1.20, G 1.50, D 60 s, cooldown 60 s, cheapest tier, with 100 and 300 bps shown side by side.

**Comparisons.** Doing nothing is the real outcome: every liquidated position is liquidated and pays the bonus. Reserve mode and the same USDC repaid upfront are read from `results/summary.json` and `results/portfolio.json`, at R 30% unless stated. Collateral mode needs no cash, so its comparison with upfront is about protection only.

**False alarms.** As in the population section: crossed T, not liquidated, HF never below 1 on the path. For them: swap cost, gas, and collateral sold as a share of their collateral's oracle value at arming, in total and per borrower. In the calm period, the same per member per 30 days.

**Results.** Saved and bonus avoided against the three comparisons; swap cost, gas and net per position and per $1,000 of debt, split by the existing size bands; members armed below T apart, because their unwind fires at once; the reasons table; one plain line per period at T 1.20: "Across N borrowers in this period, collateral mode avoided $X of liquidation bonus and paid $Y in swap costs, of which $Z on borrowers who recovered anyway." No crash frequency is estimated.

**Validation.**

- Ladder error: 1,000 unwinds per chain, drawn with a Mulberry32 generator seeded 20261108 from the population runs at T 1.20, quoted again at their exact amount on every usable tier. The difference from the ladder price is reported, with the number of cap decisions it changes.
- Second endpoint: 500 landing blocks per chain, drawn the same way, read again in full on a different endpoint than the one that answered. Quotes must agree exactly.
- Real swaps: for 1,000 landing blocks per chain, drawn the same way, every log of the quoted pools in that block. For each swap that took USDC out of the pool, its USDC amount is quoted at the block before, on that pool, and the collateral quoted is compared with the collateral the swap really paid. Swaps that were not the first event of their pool in the block are shown apart, since the pool had already moved.
- Oracle: AaveOracle prices read with the quotes, against the committed price files at the same block.
- Arbitrum landing blocks: header time against the landing time.
- An independent Python re-implementation, sharing no code with the TypeScript, of the population runs at T 1.20, G 1.50, D 60 s and both slippage settings, from the committed files. Counts and bonus must match exactly, dollar sums within 0.5%.

### Implementation notes

Added after the method above was committed, and before any saved count, bonus avoided or cost was computed. The first changes how many unwinds are quoted; the others fix details the method left open.

- **Repeat reverts are not all quoted.** The rule above retries a reverted unwind at the next observation once the cooldown has passed. A few positions are too large for their pools and retry at almost every oracle update for days. In a dry run of Arbitrum's 2025-10 window, which guessed every missing quote, 675,000 of 854,000 unwinds reverted, and the runs needed 15,700 landing blocks; the free Arbitrum endpoints served about one block a second, and 2026-02 and the calm month are longer. So, under the sampling the brief allows: once a run has had five reverts in a row, each quoted at its own landing block, a further unwind of that run that lands in the same UTC hour as its last quoted one is not quoted. It is taken to revert the same way, cap or fill, and to pay the same gas. The first unwind of each new hour is quoted, and a landing ends the streak. The same dry run then needed 3,800 landing blocks. The error is bounded in Validation: 1,000 of these stand-ins per chain, drawn with the seeded generator, are quoted at their own landing blocks, and the number that would have landed is reported. Where one would have, that run's later path is not the one shown. This was decided after seeing how many reverting retries the dry run needed, and before any outcome was computed.
- An unwind still in flight when a run stops, because the position failed or the period ended, counts as sent. Its gas and swap are left out: it would land on a liquidated position or after the period.
- Quotes are fetched in rounds. What the keeper does next depends on each quote, so the fetch simulates with the quotes it has, guesses each missing one as the run's last outcome to find what the run would need next, fetches everything found, and repeats until no run needs a quote. A run that used a guess is thrown away and run again; no guess reaches a result.
- A quote that fails inside a Multicall3 batch is asked again on its own, smallest amount first for each pool, because a heavy quote can leave too little gas for the ones after it. Once one fails on its own, larger amounts on that pool in that block are not asked. The lookup applies the same fact: a pool that could not fill an amount at a block cannot fill a larger one.
- A new landing block's header, oracle prices, pool prices and first quotes go in one JSON-RPC batch. Sentio, which caps `eth_call` at 10M gas, and `base.merkle.io`, now pruned, are not used. Tenderly's second public hostname and Blast's public Base endpoint are added.
- On Arbitrum, the price-file rows used to find a landing block are every AaveOracle update of the period.
- A member's "assets", whose price updates give its path a point, are those that move its HF: collateral that counts under its eMode, and debt. This is what the population path rebuild already used.
- For a headline position, the sold asset's units at an observation come from the member's rebuilt read in force at that block, or its first read if none applies yet.
- The unthinned path of a member that was not liquidated and never fell below 1.30 is never built. Its outcome is known: no unwind at any T.

Added after the first results were computed. They change how results are labelled and add figures; they change no outcome:

- A miss where HF crossed T but no unwind was ever sent before the position failed, because every R the rule asked for was under the $1 floor, is `under_minimum`, not `too_slow`. In the calm month most `too_slow` misses were dust positions of this kind, which the label hid.
- Gas paid by reverted unwinds, and swap cost with every unwind counted at no better than the oracle, are reported next to the totals. Many reverts are retries the naive keeper of assumption 28 would not send if it checked a quote first, and some unwinds in the 2025-10 crash sold into pools that had not caught up with the oracle.

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

For repay from collateral, in addition to 1 to 4, 7, 9 to 11, 16 to 18, 20 and 21:

25. **The swap fills at the quote.** The quote is the pool at the end of the landing block. No trade lands before the unwind in that block, no one front-runs it, and other Levee positions selling the same asset in the same block do not move the price it gets. In a real crash with many users, the price would be worse.
26. **Only Uniswap v3 pools directly against native USDC.** No route through WETH or another token, no other DEX, no aggregator. On Base most of the liquidity is elsewhere, so the cost here can be higher than a router would get, and liquid staking tokens with no direct USDC pool are `no_pool`.
27. **The helper can use any usable fee tier,** taking the cheapest at each unwind, as the brief asks. The spec fixes one `pool_fee` per position; the configured-tier sensitivity shows the difference.
28. **The keeper does not check a quote before sending.** The built keeper does, and sends nothing when the quote is past the bound; this replay models the simpler one. It sizes R on the formula and sends. A revert costs gas, and the keeper tries again at its next observation below T once the cooldown has passed, at the size the formula gives then. It does not try a smaller amount.
29. **Repeat reverts after five in a row are not all quoted.** Within the same UTC hour they take the last quoted outcome. Validation measures how often that is wrong.
30. **Gas is 600,000 per unwind sent, at the landing block's base fee,** with no priority fee, no L1 data fee and no NEAR fees. The spec expects 350,000 to 600,000 gas, not measured. A revert is charged the full amount.
31. **The aToken allowance, `max_slippage_bps`, `max_per_rescue` and `max_per_day` never bind** other than as the cap above. The sold asset is never frozen, paused or in isolation mode, and the borrower never revokes.
32. **The sold collateral is valued at the oracle.** Swap cost is measured against AaveOracle at the landing block. The deleveraging itself, collateral the borrower no longer holds when the price recovers, is not counted as a cost.
33. **A landed repay counts only up to the USDC debt still on the path,** and units sold only up to the units still held, as the capped rule in the population section does. Assumption 19 does not apply here.
34. **USDC received repays USDC debt one for one** (assumption 7). The swap cost uses AaveOracle's USDC price, so a USDC quote off $1 shows up in the cost.

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
| Collateral mode: pool price worse than the oracle by more than `max_slippage_bps` | Modelled: the unwind reverts, gas is paid, and a miss is `slippage_cap` |
| Collateral mode: pool too thin for the amount | Modelled the same way, as a revert for lack of liquidity |
| Collateral mode: no pool for the borrower's collateral | Modelled: `no_pool` |
| Collateral mode: the chosen asset runs out | Modelled: `collateral_exhausted` |
| Collateral mode: allowance too small, asset frozen, paused or isolated, borrower revoked | **Not modelled** |
| Collateral mode: other sellers in the same block | **Not modelled.** Each unwind gets the pool as it was |

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

For repay from collateral:

- **Each unwind sees the pool as it was.** In a crash where many Levee positions sell the same asset into the same pool, later sellers get worse prices. Nothing here models that, so costs and saves are for one borrower acting alone, or for a few.
- **One venue.** Only direct Uniswap v3 pools against native USDC were quoted. A route through WETH, Uniswap v4, Aerodrome on Base or an aggregator could be cheaper or deeper, and would let liquid staking tokens be sold. The helper in the spec uses one Uniswap v3 pool, which is what is measured.
- **Deleveraging is counted in collateral sold, not in dollars lost.** A borrower whose collateral was sold near the bottom of a crash holds less of it when the price recovers. That is the same exposure an upfront repay or the reserve removes, but it is not valued here.
- **The keeper is naive about reverts.** It does not quote before sending and does not try a smaller amount, so a position too large for its pool reverts over and over and pays gas each time. A keeper that sized down to what the pool can fill would save some of these positions in part and pay less gas. That keeper is not measured.
- **Gas is assumed, at 600,000 per unwind.** The built helper measured 529,000 to 595,000 on forks and 528,000 to 546,000 on testnet, so the assumption is a little high. Gas matters only for small positions and for runs that revert many times.
- **Two crashes and one calm month,** as for the population parts. No crash frequency is estimated.

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

For repay from collateral, `results/collateral.md` has the full table. Samples are drawn with Mulberry32 seeded 20261108, one generator per chain, from the population runs at T 1.20, both caps.

| Check | Base | Arbitrum |
|---|---|---|
| Every header, oracle price, pool price and quote of 500 sampled landing blocks, read again on another endpoint | 29,126 values, 0 differ. 82 calls could only be re-read on the same endpoint | 26,390 values, 0 differ |
| Real swaps that took USDC out of a quoted pool in 1,000 sampled landing blocks, the first event of their pool in the block, against a quote of the same USDC at the block before | 469 swaps, median 0.0000 bps, 466 within 0.1 bps, worst 31.8 bps | 74 swaps, median 0.0000 bps, 73 within 0.1 bps, worst 0.24 bps |
| The same, for swaps after another event of their pool in that block, when the pool had already moved | 895 swaps, median 1.8 bps | 86 swaps, median 0.75 bps |
| The ladder line against an exact quote of the same unwind, 1,000 per chain, both quotable in 871 and 760 | median 0.011 bps, p95 3.6 bps. Cap decisions changed: 0 at 100 bps, 2 at 300 bps | median 0.106 bps, p95 18 bps. Cap decisions changed: 1 at 100 bps, 4 at 300 bps |
| Where the line was below the exact quote | 94 cases, by at most 3.8 bps, the largest on cbBTC sales under $30, where one satoshi is up to 10 bps: rounding to the smallest unit | 68 cases, by at most 5.4 bps, the largest on WBTC sales under $20 |
| Repeat reverts taken without a quote, 1,000 per chain, quoted at their own landing blocks | 965 revert the same way, 22 the other way, 13 would have landed | 986 the same way, 8 the other way, 6 would have landed |
| AaveOracle price of the sold asset read with the quotes, against the committed price files, at every unwind of the headline cell | 18,336, all equal to float rounding | 35,202, all equal to float rounding |
| Landing block's header time against the landing time | 18,336, all 0 s | 35,202, range −6 to +5 s, 99.93% within 2 s |
| Independent Python re-implementation, T 1.20, G 1.50, D 60 s, both caps, every period | Every count, the bonus and every dollar sum match: 102 checks | Same: 102 checks |

To run the last check: `python3 backtest/scripts/verify_collateral.py [--period 2025-10|2026-02|calm] [--chain base|arbitrum]`. It shares no code with the TypeScript, reuses only the decoders of `verify_portfolio.py`, rebuilds every path, the sold asset, the landing blocks and the ladder lookups from the committed files, and checks members, `no_pool`, liquidated, saved, bonus avoided, crossings, false alarms and every unwind count exactly, and repaid, sold, swap cost and gas within 0.5%: 204 checks, all matching. It takes about an hour.

So the ladder line overstates the cost where it errs, apart from rounding of a token's smallest unit on sales of a few dollars, which the pre-registered method did not foresee.

Tests cover the collateral rule, with a hand-worked rescue, its reverts and misses, in `test/unwind.test.ts`; the landing block, the ladder, the cheapest tier, the cap and repeat reverts in `test/quotes.test.ts`; and the sold-asset choice and unthinned paths in `test/collateralPaths.test.ts`.

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
| `src/sim/unwind.ts` | The repay-from-collateral keeper rule. Pure |
| `src/collateral` | Pools, quote lookup, collateral-mode paths, runs, aggregation and Markdown for `collateral.md` |
| `src/fetch/pools.ts`, `quotes.ts`, `collateralCheck.ts` | Usable pools, quotes at landing blocks in rounds, and the quote validation |
| `data/derived` | Committed inputs to the run |
| `data/derived/collateral` | Usable pools per period, quotes per chain and period, and the quote validation |
| `data/derived/portfolio` | Population files per chain and period, calm-period prices and markets, the validation sample |
| `data/derived/daily.json`, `calm.json` | Daily WETH price and USDC rates, and the calm period the rule picked |
| `data/raw` | Raw responses, git-ignored |
| `results` | Outputs, committed |
