# Levee EVM

`LeveeUnwind`, the helper for repaying from collateral (docs/SPEC.md section 9), its deploy and testnet scripts, and Foundry tests against the live Aave v3 and Uniswap v3 deployments at pinned blocks. The tests use the deployed bytecode, not a vendored copy, so a change in Aave's or Uniswap's behaviour fails a test here. Nothing is sent to a real chain: the tests only read chains to build forks, and the scripts broadcast only when run with `--broadcast`.

## Run

Needs Foundry 1.5.1. From the repo root:

```sh
git submodule update --init evm/lib/forge-std evm/lib/openzeppelin-contracts
cd evm
forge test -vv
```

One suite at a time:

```sh
forge test -vv --match-contract BaseRepayTest
forge test -vv --match-contract ArbitrumRepayTest
forge test -vv --match-contract BaseCrashTest
forge test -vv --match-contract UnwindBaseTest
forge test -vv --match-contract UnwindArbitrumTest
forge test -vv --match-contract UnwindBaseSepoliaTest
forge test -vv --match-contract UnwindArbitrumSepoliaTest
forge test -vv --match-contract UnwindPoolChoiceBaseTest
```

The crash comparison prints its table with:

```sh
forge test -vv --match-test test_crash_printsTheDifference
```

The first run pages state in from public RPCs and took about 20 seconds when measured. Foundry caches it under `~/.foundry/cache`, and later runs take about a second. To check a cold run without clearing that cache:

```sh
forge test --no-storage-caching
```

The unwind suites read far more state: about a minute per suite on a cold cache. With the default thread count, `arbitrum-one.public.blastapi.io` answered some reads with HTTP 429 on a cold run. `--threads 2` avoided it.

## RPC endpoints

| Variable | Default | Used for |
|---|---|---|
| `BASE_FORK_RPC_URL` | `https://mainnet.base.org` | `BaseRepayTest`, `BaseCrashTest`, `UnwindBaseTest`, `UnwindPoolChoiceBaseTest` |
| `ARBITRUM_FORK_RPC_URL` | `https://arbitrum-one.public.blastapi.io` | `ArbitrumRepayTest`, `UnwindArbitrumTest` |
| `BASE_SEPOLIA_FORK_RPC_URL` | `https://sepolia.base.org` | `UnwindBaseSepoliaTest` |
| `ARBITRUM_SEPOLIA_FORK_RPC_URL` | `https://arbitrum-sepolia.gateway.tenderly.co` | `UnwindArbitrumSepoliaTest` |

No API key is needed. Set a variable to use your own archive endpoint. A fork that lands on the wrong chain or block fails in `setUp` rather than passing quietly.

## Pinned blocks

| Chain | Block | Timestamp | Pool revision |
|---|---|---|---|
| Base | 54,260,000 | 1794042375 | 11 |
| Arbitrum One | 522,040,000 | 1794041907 | 11 |
| Base Sepolia | 56,000,000 | 1794121868 | 10 |
| Arbitrum Sepolia | 328,000,000 | 1794349405 | 3 |

Blocks are set in `Targets` in `test/lib/AaveFork.sol`, and `FORK_BLOCK` in `keeper/test/support/anvil.ts` must match the Base one.

The pin is checked by timestamp because `block.number` on an Arbitrum fork is the L1 block number.

## Public RPC archive access

Measured on 2026-11-07 with `eth_call` at increasing depth.

| Endpoint | Result |
|---|---|
| `mainnet.base.org` | Served state 5,000,000 blocks back |
| `base.drpc.org` | Served state 5,000,000 blocks back |
| `base-rpc.publicnode.com` | Served 1,000,000 back, then needs a token |
| `arbitrum-one.public.blastapi.io` | Served 20,000,000 blocks back |
| `arb-one.api.pocket.network`, `arb-pokt.nodies.app` | Served 20,000,000 blocks back |
| `arb1.arbitrum.io/rpc` | Prunes. Only recent state and scattered older blocks |
| `arbitrum-one-rpc.publicnode.com`, `arbitrum.drpc.org` | No archive state without a token |
| `sepolia.base.org` | Served state 5,000,000 blocks back, measured on 2026-11-08 |
| `base-sepolia-rpc.publicnode.com` | Served 1,000,000 blocks back, measured on 2026-11-08 |
| `arbitrum-sepolia.gateway.tenderly.co` | Served state at block 300,000,000, about 28,000,000 blocks back, measured on 2026-11-11 |
| `sepolia-rollup.arbitrum.io/rpc` | Prunes. Refused state at block 328,000,000, a few hours old, measured on 2026-11-11 |
| `arbitrum-sepolia-rpc.publicnode.com`, `arbitrum-sepolia.public.blastapi.io` | No archive state without a token, measured on 2026-11-11 |

A public endpoint can change this at any time. If a fork read fails with a missing-state error, set the variable to another archive endpoint.

## What is covered

`test/lib/RepayPath.sol` runs unchanged on both chains, through `BaseRepay.t.sol` and `ArbitrumRepay.t.sol`.

| Test | Shows |
|---|---|
| `test_specChainFacts` | Spec section 3 selectors and addresses |
| `test_position_hasWethCollateralAndUsdcVariableDebt` | The position under test is what it claims |
| `test_thirdPartyRepay_explicitAmount_collateralDoesNotMove` | A third party repays, and scaled collateral, aWETH and wallet balances are exactly unchanged |
| `test_repayFormula_reachesTarget` | The spec formula reaches its target on the live Pool |
| `test_maxUintOnBehalf_reverts` | `type(uint256).max` on behalf of someone else reverts |
| `test_maxUintBySelf_clearsDebt` | The same call from the borrower is legal |
| `test_amountAboveDebt_chargesOnlyTheDebt` | An amount above the debt is clamped |
| `test_repayWithoutAllowance_reverts` | Too little allowance reverts and moves nothing |
| `test_repayZero_reverts` | A zero amount reverts |
| `test_repayAfterDebtCleared_reverts_withoutCharging` | Losing the race to clear the debt costs no USDC |

`BaseCrash.t.sol` forces a price path with `vm.mockCall` on `AaveOracle.getAssetPrice(WETH)`. Everything else is the live deployment.

## Recorded Aave behaviour

What the forks actually did, at Pool revision 11.

| Case | Result |
|---|---|
| Repay on behalf, explicit amount | Returns the amount. The caller pays it and collateral is untouched |
| `type(uint256).max` on behalf of someone else | Reverts `NoExplicitAmountToRepayOnBehalf()` |
| `type(uint256).max` from the borrower | Allowed, clears the debt |
| Amount above the debt, 13,581.859635 against 12,581.859636 owed on Base | Returns the debt. Only the debt leaves the caller's balance and allowance |
| Amount of 0 | Reverts `InvalidAmount()` |
| Repay when there is no debt | Reverts `NoDebtOfSelectedType()` and charges nothing |
| Allowance below the amount | Reverts `ERC20: transfer amount exceeds allowance`, nothing moves |
| Debt right after borrowing | 1 base unit above the amount borrowed, on both chains |

Two results changed the keeper:

- **The bare formula lands short.** Rounded up to a whole USDC base unit, the repay reached 1.749999999925 against a target of 1.75 on Base. Aave burns scaled debt rounding down and reads the balance rounding up, so a repay of `R` can remove about 2 base units less than `R`. With 2 base units added it reached 1.750000000250 on Base and 1.750000000209 on Arbitrum. The spec and `keeper/src/decision.ts` both add them.
- **USDC is not priced at $1.** The oracle read 0.99975 on Base and 0.9998773 on Arbitrum at these blocks, so the repay is converted at the oracle price.

## Gas

`repay` used about 160,000 gas on both chains. That is 158,745 on Base and 160,254 on Arbitrum with cold storage, and 162,472 from the receipt of a real transaction in the keeper's end-to-end test on the Base fork.

```sh
forge test --isolate --match-test test_thirdPartyRepay -vv
```

The contract's `gas_limit_repay` needs real headroom. Aave's nested calls fail on a tight limit under the 63/64 rule: in the keeper's end-to-end test, a `borrow` sent with a stale estimate of 284,079 gas reverted at 276,385 used, and the same call succeeded when replayed with more. The figures here are execution gas only. On Arbitrum a transaction's gas also pays for its L1 data, which a fork does not model, so confirm that chain's limit with a testnet run.

## Forced crash result

Base at block 54,260,000. 10 WETH against USDC at health factor 1.50, trigger 1.25, target 1.60, and WETH forced from $2,246.19 to $1,392.64.

| | No rescue | Rescued at the trigger |
|---|---|---|
| Health factor at the crash | 0.9299 | 1.1913 |
| Liquidated | Yes | No, `HealthFactorNotBelowThreshold()` |
| WETH collateral left | 0.5161 | 10.0000 |
| USDC debt left | 0.00 | 9,821.71 |
| USDC from the reserve | 0.00 | 2,760.14 |
| Net equity at the crash price | $718.78 | $1,347.71 |

The rescued position is better off by $628.93, which the test asserts equals the 5% liquidation bonus on the debt the liquidator closed. Net equity counts reserve USDC as spent, so the comparison is fair to the unrescued case.

This is a forced price path that steps through the trigger before the crash. It shows the mechanism, not how often a real rescue beats a liquidator. A gap straight past the trigger, or a slow keeper, can still lose.

## LeveeUnwind

`src/LeveeUnwind.sol` repays part of a borrower's USDC variable debt by selling a slice of their own collateral in one transaction. There is one deployment per chain, with no owner, no upgrade, no admin method, no `delegatecall`, no arbitrary call and no ETH handling. OpenZeppelin Contracts v5.7.0 (`lib/openzeppelin-contracts`, pinned) supplies `SafeERC20`, `SafeCast` and `Math.mulDiv`.

```solidity
// From the borrower's own wallet. 0 < maxSlippageBps <= 300, 1e18 < triggerHf < targetHf <= 3e18.
// collateral is an Aave reserve other than USDC, and the (collateral, USDC, poolFee) pool exists.
function authorize(address rescuer, uint16 maxSlippageBps, uint64 triggerHf, uint64 targetHf,
    address collateral, uint24 poolFee) external;
function revoke() external;
function authorizationOf(address borrower) external view
    returns (address rescuer, uint16 maxSlippageBps, uint64 triggerHf, uint64 targetHf,
        address collateral, uint24 poolFee);
// Only the borrower's rescuer, only for their collateral and pool, only below the trigger.
function unwind(address borrower, address collateral, uint256 amount, uint24 poolFee, uint256 maxSold)
    external returns (uint256 repaid, uint256 sold);

event Authorized(address indexed borrower, address indexed rescuer, address indexed collateral,
    uint24 poolFee, uint16 maxSlippageBps, uint64 triggerHf, uint64 targetHf);
event Revoked(address indexed borrower, address indexed rescuer);
event Unwound(address indexed borrower, address indexed rescuer, address indexed collateral, uint256 repaid, uint256 sold);
```

| Call | Selector |
|---|---|
| `unwind(address,address,uint256,uint24,uint256)` | `0x65afae08` |
| `authorize(address,uint16,uint64,uint64,address,uint24)` | `0x4d4bb5b7` |
| `authorizationOf(address)` | `0xcc90b6bb` |
| `revoke()` | `0xb6549f75` |

`test_chainFacts` asserts all four. The constructor takes the Aave `PoolAddressesProvider`, USDC and the Uniswap v3 factory. The Pool, the oracle and the price oracle sentinel are read from the provider on every call. The `Unwound` event and its topic did not change with the audit fixes.

### What `unwind` does

1. Refuses a re-entered call, a caller who is not the borrower's rescuer, a zero amount and a zero `maxSold`.
2. Refuses any collateral or fee tier other than the ones the borrower authorized, with `TermsMismatch(collateral, poolFee)`.
3. Reads the market's `PriceOracleSentinel` from the provider and, if one is set, refuses while `isLiquidationAllowed()` is false, with `PriceOracleSentinelRefused(sentinel)`.
4. Reads the health factor from `Pool.getUserAccountData` and refuses it at or above the borrower's trigger.
5. Refuses collateral that is not an Aave reserve, or is inactive or paused. Frozen collateral is sold. Caps `amount` at the USDC variable debt.
6. Computes `maxIn = amount * price(USDC) / price(collateral) * (1 + maxSlippageBps)` in collateral base units from Aave's oracle, with one `mulDiv` that rounds down. Both prices are in the oracle's base currency, so its unit cancels. The decimals come from Aave's reserve configuration.
7. Looks the pool up with `factory.getPool(collateral, USDC, poolFee)` and starts an exact-output swap for `amount` USDC to itself, with the price limit at the end of the range.
8. In the callback, accepts only the pool it is swapping on, once: the pool address sits in transient storage and the callback clears it on entry. It requires exactly `amount` USDC received, collateral owed of at most `maxIn` (`SlippageExceeded`) and at most `maxSold` (`MaxSoldExceeded`). It repays `amount` with `Pool.repay(USDC, amount, 2, borrower)`, pulls the owed aTokens from the borrower with `transferFrom`, and withdraws its whole aToken balance from Aave to the pool. If the transfer left it short of what it owes, which happens only on Aave v3.0 (below), it first pulls the shortfall, at least one scaled unit's worth.
9. Reads the health factor again. It must have risen, and must not exceed the bound below.

`maxSlippageBps` is all in: the pool fee counts against it. A 0.30% pool leaves 70 bps of a 100 bps bound for price impact and for the pool's distance from the oracle.

### The rescuer's cap, `maxSold`

The NEAR contract publishes the signed transaction before it lands, so a searcher can sandwich it. With only the borrower's oracle bound, the front-run could push the pool almost to that bound. The keeper therefore passes `maxSold`: a fresh Uniswap QuoterV2 `quoteExactOutputSingle` for the same pool and amount, taken just before it asks NEAR to sign, plus a tolerance of 50 bps by default. The helper takes the tighter of `maxSold` and `maxIn`, so the cap can only tighten the borrower's bound. A stolen keeper key can pass any `maxSold` and is still held to `maxSlippageBps`: the worst it can do is what it could before. The NEAR contract cannot price the cap and only refuses zero.

The auditor's sandwich, at the largest front-run push that still lets the unwind through, with a 100 bps bound. Cost is the borrower's, against Aave's oracle. Profit is the searcher's best over ten pushes up to that one, at oracle prices:

| Fork, pool, repaid | Honest cost | With `maxSold`: cost, searcher profit | Without: cost, searcher profit |
|---|---|---|---|
| Base, 0.05%, 12,421 USDC | 6.2 bps | 56.2 bps, -$2.98 | 99.9 bps, -$5.59 |
| Base, 0.05%, 248,420 USDC | 70.7 bps | 100.0 bps, $674.35 | 100.0 bps, $674.35 |
| Arbitrum, 0.05%, 12,423 USDC | 7.0 bps | 57.0 bps, -$36.73 | 100.0 bps, -$68.97 |
| Arbitrum, 0.05%, 248,470 USDC | 20.6 bps | 70.7 bps, $810.94 | 99.9 bps, $1,291.51 |
| Base Sepolia, seeded 0.30%, 12,727 USDC | 36.2 bps | 86.3 bps, -$24.72 | 99.9 bps, -$31.78 |

The cap holds a sandwich to the tolerance: the borrower pays at most about 50 bps more than the quote said. Where the honest sale already costs within 50 bps of the bound, as for $248k on Base's thin 0.05% pool, the bound binds first and the cap adds nothing. A lower `quote_tolerance_bps` in the keeper's positions file narrows the window, at the cost of an unwind that reverts when the pool moves by more between the quote and inclusion. No pre-swap check of the pool's spot price against its TWAP was added: the cap bounds the same manipulation, and a fork cannot advance the observations of the Base Sepolia pool the seed script moves.

### The post-check bound

The keeper sizes the repay for the worst cost it allows, `s_w = maxSlippageBps + poolFee`, with section 9's `R = (T*D - C*L) / (T - L_c*(1 + s_w))`. If the swap actually costs `s`, the health factor lands at

```
HF_after = T + R * L_c * (s_w - s) / D_after
```

with `L_c` the collateral's liquidation threshold and `D_after` the debt left, both from Aave. `R * (s_w - s)` is what a worst-case swap would have spent less what this one did, which the helper knows exactly from the oracle and the swap. Taking `L_c` as 1 gives a term that needs no reserve parameters and uses Aave's own account data, so Aave handles eMode and several collaterals. Two terms go on top:

```
bound = T
      + 2% * (T - HF_before)
      + (C_after + sold * price(collateral)) * 1 bp / D_after
      + (repaid * price(USDC) * (1 + s_w) - sold * price(collateral)) / D_after
```

- `HF_MARGIN_BPS`, 200, of the distance the unwind lifts the health factor. A sale past the keeper's amount buys health factor at about `(T - L_c(1 + s)) / D_after` per unit, and the keeper's `R` is `D * (T - HF_before) / (T - L_c(1 + s))`, so the over-sale this term allows is about 2% of `R` times `D_after / D`, whatever the band, the target or the liquidation threshold. The old margin, 1% of the target, did not have that property: for a narrow band its 0.0121 was larger than the whole move.
- One basis point of the collateral before the sale over the debt left. Aave truncates the averaged liquidation threshold to whole basis points before and after the sale, so with several collaterals an honest unwind can land up to this much above the formula. With one collateral the average is exact and the term is slack.

A repay of the whole debt leaves an unbounded health factor and does not pass: no target up to 3.0 needs one. An honest keeper's unwind passes on a static oracle, which every fuzz run checks, bands as narrow as 0.005 included. A rise in the collateral's oracle price between the keeper's read and inclusion lifts the result by about the rise times `C * L / D_after`, and the margin is now smaller than before, so less of such a rise is absorbed. Past it the unwind reverts with `OverSold`: only gas is lost, the position is safer than the keeper read, and the next pass sizes again from a fresh read. On a narrow band a rise that large usually lifts the health factor above the trigger first, and the unwind reverts with `AboveTrigger` as it did before. Not measured on the forks.

For bands narrower than about 0.01 the fixed one-basis-point term dominates the over-sale allowed, since it does not shrink with the band: the 1.20/1.21 case below allows 3.0%, of which about 0.7 points come from it.

The largest sale the post-check allows, in multiples of the keeper's own amount, found by bisection to 1 bp with no cap from the rescuer. 10 WETH, 100 bps, deepest pool. The eMode cases use a category the test creates as pool admin, WETH collateral and USDC borrowable at LTV 94% and threshold 95%, because no category on these forks lets USDC be borrowed against a 95% threshold:

| Case | Base, old | Base, new | Arbitrum, old | Arbitrum, new | Base Sepolia, old | Base Sepolia, new |
|---|---|---|---|---|---|---|
| WETH from 1.05, trigger 1.2, target 1.5 | 1.0119 | 1.0083 | 1.0124 | 1.0087 | 1.0118 | 1.0082 |
| WETH from 1.19, trigger 1.20, target 1.21 | 1.5580 | 1.0296 | 1.5595 | 1.0304 | 1.5576 | 1.0302 |
| eMode 95% from 1.02, trigger 1.03, target 1.05 | 1.2105 | 1.0212 | 1.2149 | 1.0223 | 1.2114 | 1.0222 |
| eMode 95% from 1.05, trigger 1.2, target 1.5 | 1.0060 | 1.0041 | 1.0062 | 1.0044 | 1.0061 | 1.0042 |

"Old" is the previous margin, run by putting it back in the source; the headroom tests fail on it.

### Tests

`test/lib/UnwindPath.sol` runs on all four forks, through `UnwindBase.t.sol`, `UnwindArbitrum.t.sol`, `UnwindBaseSepolia.t.sol` and `UnwindArbitrumSepolia.t.sol`. Every test that reaches the helper ends by asserting that it holds no USDC, WETH, aWETH, scaled aWETH, debt, USDC allowance or ETH. Every keeper-sized unwind sets `maxSold` as the keeper does, from QuoterV2 plus 50 bps, and asserts the quote equals the sale exactly.

| Test | Shows |
|---|---|
| `test_unwind_deepestPool_fromNearLiquidationToTarget` | 10 WETH at HF 1.05, a keeper-sized unwind to 1.5 on the deepest pool. Checks the event, the return values, debt, aWETH, allowance, both pool balances, the oracle bound, `maxSold`, wallets, HF against a repay-then-sell model, and the post-check bound, all from reads that do not go through the helper |
| `test_unwind_otherPool_fromNearLiquidationToTarget` | The same on the second real fee tier, authorized for it |
| `test_unwind_justBelowTrigger_succeeds`, `test_unwind_aboveTrigger_reverts`, `test_unwind_withNoDebt_isAboveTrigger` | The trigger |
| `test_unwind_largeOverSale_isBlocked`, `test_unwind_overSaleHeadroom_*`, `test_unwind_eMode95_keeperAmountPasses` | The post-check, and the table above |
| `test_unwind_amountAboveDebt_isCappedThenBlocked` | The cap holds, the full repay it makes is refused, and nothing moves |
| `test_authorize_*`, `testFuzz_authorize_healthFactorBounds` | Storage, events, `revoke`, every rejected value, USDC, a non-reserve and a fee tier with no pool, and the edges |
| `test_unwind_byAnyoneButTheRescuer_reverts`, `test_unwind_afterRevoke_reverts`, `test_unwind_afterAllowanceRemoved_reverts` | Who can call, and both ways to stop it |
| `test_unwind_unauthorizedCollateralOrPool_reverts` | L-1: USDC, another reserve, a non-reserve and every other fee tier, real pools included, all `TermsMismatch` |
| `test_unwind_zeroMaxSold_reverts`, `test_unwind_saleAboveMaxSold_reverts`, `test_unwind_maxSoldCannotLoosenTheOracleBound` | M-1: the rescuer's cap, one unit under the quote, and a cap above the oracle bound |
| `test_sandwich_isBoundedByTheKeepersMaxSold`, `test_sandwich_largeUnwind_isBoundedByTheKeepersMaxSold` | M-1: the auditor's sandwich, 10 and 200 WETH, the table above. The large one skips Base Sepolia, whose seeded pool is too small |
| `test_unwind_slippageBoundBelowPoolCost_reverts` | A 1 bp bound against a real pool fee |
| `test_unwind_poolPushedOffOracle_reverts` | A whale sale moves the pool 3% before the unwind |
| `test_unwind_poolTooThin_reverts` | A real pool, created by the factory owner on the fork and authorized, too thin for the amount |
| `test_unwind_allowanceTooSmall_reverts`, `test_unwind_collateralBalanceTooSmall_reverts` | The borrower's limits |
| `test_unwind_zeroAmount_reverts` | Inputs |
| `test_callback_fromFakePool_reverts`, `test_callback_fromTheRealPoolWithNoUnwind_reverts` | Spoofed callbacks |
| `test_reentrancy_throughCollateralToken_isRefused` | The real WETH code is wrapped in place by a token that, while Aave pays the pool, tries to unwind a second borrower who authorized it, then calls the callback. It gets `Reentrancy()` and `UnexpectedCallback()`, and the honest unwind's numbers are exact |
| `test_unwind_frozenCollateral_isSold` | L-2: frozen WETH, at LTV 0 on revisions 10 and 11, is sold to the target |
| `test_unwind_pausedCollateral_reverts`, `test_unwind_inactiveCollateral_reverts` | Paused, as pool admin, and inactive, written into the Pool's storage since Aave refuses to deactivate a reserve with suppliers |
| `test_unwind_otherCollateralAtLtvZero_isRefusedByAave` | L-2: the auditor's F3. A second collateral at LTV 0 makes Aave revert `LtvValidationFailed()`. The keeper detects it instead |
| `test_unwind_sentinelRefusing_reverts_thenAllows` | I-3: none of the forks has a sentinel, so the provider's owner sets a mock one after deployment. The same unwind is refused, then passes |
| `test_unwind_isolationModeBorrower` | Revision 10 only: a debt ceiling written into WETH's configuration, a borrower in isolation mode, and an unwind that releases the ceiling. Skipped on revision 11, which has no isolation mode |
| `test_unwind_donatedATokens_goToThePool`, `test_unwind_manySmallUnwinds_stopAtTheTrigger` | I-2 and the auditor's sequence test, below |
| `testFuzz_unwind_amountAndSlippage`, `testFuzz_unwind_triggerAndTarget` | 256 runs each per fork, every run held to the happy path's checks. Bands down to 0.005 |
| `test_constructor_rejectsWrongArguments` | Deployment checks |

Base Sepolia adds `test_baseSepolia_isPoolRevision10`, `test_seed_putsThePoolAtTheOraclePrice`, `test_seed_rerun_followsTheOracle`, `test_seed_rerunInsideFaucetTimelock_saysWhy`, `test_seed_mintDeadline_leavesTimeToBroadcast` and `test_wrongFeeTier_stalePools_revert`.

Arbitrum Sepolia adds `test_arbitrumSepolia_isPoolRevision3`, the same seed tests without the faucet's, `test_seed_withoutUsdc_saysWhy` and `test_seed_liveFunding_borrowsUsdcOnAave`. The last rehearses the live set-up at its size: a deployer with only ETH wraps it, supplies WETH to Aave, borrows USDC, seeds the pool with it, and a 0.05 WETH borrower is unwound by 34 USDC to the target. Its market lists only WETH and USDC, so the two tests that need a second collateral skip, and so do the three eMode tests: Pool revision 3 configures eMode through an older interface. The large sandwich skips as on Base Sepolia. `test_chainFacts` checks that QuoterV2's WETH9 is not the market's WETH there: Aave lists its own wrapper, and the keeper's ERC-20 quotes do not touch WETH9. `test_unwind_overSaleHeadroom_isSmall` allows 1.25% there instead of 1%: WETH's liquidation threshold is 78%, lower than on the other markets, so the keeper's amount is smaller and the same slack is a larger share of it, 1.0104 times when measured.

`UnwindPoolChoiceBase.t.sol` is the auditor's F2 on Base: an accomplice primes the near-empty 0.04% WETH/USDC pool 0.9% under the oracle, inside the borrower's bound, and the rescuer routes the sale through it. Before the fix it went through and the accomplice kept the bound; now it reverts with `TermsMismatch` and the authorized 0.05% pool still works.

Each regression test fails with its fix undone in the source and passes with it.

### Aave v3.0 rounding, found on Arbitrum Sepolia and fixed

Aave's Arbitrum Sepolia market runs Pool revision 3, Aave v3.0. There, an aToken transfer converts the amount to scaled units rounding half up, and one scaled unit of WETH was worth 4.67 wei, the reserve's income index. Pulling `owed` from the borrower could leave the helper one wei short, `withdraw` then returned `owed - 1`, and every unwind reverted with `ShortWithdraw`. Nothing moved, but nothing could be sold either: 21 of 52 tests failed on the first run of the Arbitrum Sepolia fork on 2026-11-11. Later revisions round the transfer in the receiver's favour, so Base, Arbitrum One and Base Sepolia were never affected.

The helper now reads its aToken balance after the transfer and, if it is below `owed`, pulls the difference too, at least one scaled unit's worth, `ceil(index / 1e27)` base units, because a smaller transfer rounds to nothing. That goes to the pool with the rest. The borrower pays at most about one scaled unit more than `sold`, about 5 wei of WETH on Arbitrum Sepolia, where the tests allow 2 wei plus twice that. On the other revisions the second transfer never runs, and the balance read adds about 3,800 gas. The change came after the security review, and the Base Sepolia deployment at `0x308a7b28…63D2` predates it.

### Known behaviour, left as is

- **I-2, donated aTokens.** The helper withdraws its whole aToken balance in the callback, so that no scaled dust stays. aTokens anyone sends to the helper therefore go to the Uniswap pool with the next unwind of that collateral. Nobody can take them back, the borrower pays only for their own sale, and the helper still holds nothing afterwards. `test_unwind_donatedATokens_goToThePool` records it.
- **A run of small unwinds.** A rescuer may split a sale into many small unwinds while the health factor is below the trigger. The run stops at the trigger, short of one honest unwind: 13 unwinds of a twentieth of the keeper's amount on Base. `test_unwind_manySmallUnwinds_stopAtTheTrigger` records it.
- **A stolen keeper key** can still pass `maxSold` up to the borrower's bound and fire at the worst moment within it. The NEAR caps, the trigger, the post-check and the borrower's `revoke()` bound that.

### Recorded results

10 WETH at HF 1.05, trigger 1.2, target 1.5, slippage bound 100 bps.

| Fork, pool | Repaid USDC | Sold WETH | Cost against oracle | HF after |
|---|---|---|---|---|
| Base, 0.30% (deepest) | 12,461.23 | 5.573707 | 49.4 bps | 1.5153 |
| Base, 0.05% | 12,421.05 | 5.531853 | 6.2 bps | 1.5186 |
| Arbitrum, 0.05% (deepest) | 12,423.54 | 5.532317 | 7.0 bps | 1.5184 |
| Arbitrum, 0.30% | 12,463.73 | 5.578282 | 57.6 bps | 1.5137 |
| Base Sepolia, seeded 0.30% | 12,727.00 | 5.721938 | 36.2 bps | 1.5190 |
| Arbitrum Sepolia, seeded 0.30% | 9,666.54 | 4.725716 | 35.1 bps | 1.5128 |

On Base the 0.30% pool holds the most in-range liquidity, 3.25e19 against 7.81e17, but for this size the 0.05% pool costs an eighth as much. The fee, not the depth, decides `pool_fee` at this size.

The health factor lands above the target because the keeper sized for a 130 or 105 bps cost and paid less. The Base Sepolia and Arbitrum Sepolia costs are the 0.30% fee plus impact on liquidity seeded at the oracle price, so they are not a measure of slippage. Arbitrum Sepolia repays less for the same 10 WETH because its WETH is priced lower and its liquidation threshold is 78%.

### Gas

Cold storage, `forge test --isolate`:

| Fork, pool | `unwind` gas |
|---|---|
| Base, 0.30% | 568,836 |
| Base, 0.05% | 598,708 |
| Arbitrum, 0.05% | 583,409 |
| Arbitrum, 0.30% | 583,245 |
| Base Sepolia, seeded 0.30% | 532,978 |
| Arbitrum Sepolia, seeded 0.30%, with the v3.0 top-up | 665,938 |

Measured on 2026-11-11, after the Aave v3.0 fix. Its balance read added 3,735 to 3,841 gas on each of the first five, and on Arbitrum Sepolia the second aToken transfer runs too.

Before the Aave v3.0 fix, `forge test --isolate --gas-report` gave 521,847 to 587,563 over the same calls, about 4,800 more than before the audit fixes: the sentinel read, the second storage slot of the authorization and `maxSold`. `authorize` costs 112,047 to 114,286, with its reserve and pool checks. A `gas_limit_unwind` of 1,000,000 leaves about 70% headroom for the 63/64 rule in the nested Aave and Uniswap calls and for swaps that cross more ticks, and 50% on Arbitrum Sepolia with its top-up. A market with a sentinel adds its Chainlink read. On Arbitrum a transaction's gas also pays for its L1 data, which a fork does not model. Read from Arbitrum's NodeInterface (`0x…C8`, `gasEstimateL1Component`) on 2026-11-11 for an `unwind` call: 938 gas on Arbitrum One at a 0.02 gwei base fee, and 0 on Arbitrum Sepolia, whose L1 base fee estimate read zero. Both fit the limit. Deployment costs 2,198,239 gas; Foundry's simulation, with its margin, estimates 2.85M to 2.89M on the first three chains.

```sh
forge test --isolate --match-test 'test_unwind_(deepest|other)Pool' -vv
```

### Recorded Aave and Uniswap behaviour

| Case | Result |
|---|---|
| `withdraw(asset, type(uint256).max, uniswapPool)` inside the swap callback | Works on revisions 10 and 11, and burns the whole scaled balance, so no aToken dust stays |
| aToken `transferFrom` | Aave rounds in the receiver's favour and spends the allowance by the sender's real balance change. Pool overpayment, aWETH lost beyond `sold`, and allowance spent beyond `sold` all stayed within 2 wei. The keeper should expect an allowance a few wei above what it plans to sell. An unlimited allowance is not spent |
| Frozen reserve | Aave allows withdraw, and from v3.6 sets the reserve's LTV to 0. The helper sells it |
| Another enabled collateral at LTV 0 | Aave lets only an LTV-0 asset leave first, and reverts any other aToken transfer with `LtvValidationFailed()`, `0x5b263df7` |
| Price oracle sentinel | None set on the three markets at the pinned blocks; `getPriceOracleSentinel()` returns zero |
| Isolation mode | Removed in Aave v3.7, Pool revision 11. On revision 10, Aave lets an isolated borrower be unwound and the repay releases the debt ceiling |
| An exact-output swap through an empty range | Fills what it can and stops at the price limit: `PartialFill` |
| A pool already at the bottom of its range | Uniswap reverts `SPL` |
| QuoterV2 `quoteExactOutputSingle` just before the swap | Equals the collateral the swap takes, to the wei, on all four forks |
| aToken `transferFrom` on Pool revision 3 | Converts to scaled units rounding half up, so the receiver can get one base unit less than the amount. A transfer smaller than one scaled unit, 4.67 wei of WETH on Arbitrum Sepolia, can move nothing. The helper allows for both |

## Verified addresses

Read on chain at the pinned blocks. `script/lib/Deployments.sol` holds them, and `test_chainFacts` checks them on every fork.

| Chain | Aave PoolAddressesProvider | Uniswap v3 factory | WETH/USDC pools by fee |
|---|---|---|---|
| Base | `0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D` | `0x33128a8fC17869897dcE68Ed026d694621f6FDfD` | 0.30% `0x6c561B446416E1A00E8E93E221854d6eA4171372`, 0.05% `0xd0b53D9277642d899DF5C87A3966A349A798F224` |
| Arbitrum One | `0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb` | `0x1F98431c8aD98523631AE4a59f267346ea31F984` | 0.05% `0xC6962004f452bE9203591991D15f6b388e09E8D0`, 0.30% `0xc473e2aEE3441BF9240Be85eb122aBB059A3B57c` |
| Base Sepolia | `0xE4C23309117Aa30342BFaae6c95c6478e0A4Ad00` | `0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24` | 0.30% `0x92266210FacF124f190fbad79AA230dfB85926Ce`, seeded by the script |
| Arbitrum Sepolia | `0xB25a5D144626a0D488e52AE717A051a2E9997076` | `0x248AB79Bbb9bC29bB72f7Cd42F17e054Fc40188e` | 0.30% `0x99A927D8127b7215FC11Ce1F1009e77ff8B1d1b0`, seeded by the script |

The keeper quotes `maxSold` from Uniswap v3 QuoterV2. The helper never calls it.

| Chain | QuoterV2 |
|---|---|
| Base | `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a` |
| Arbitrum One | `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` |
| Base Sepolia | `0xC5290058841028F1614F3A6F0F5816cAd0df5E27` |
| Arbitrum Sepolia | `0x2779a0CC1c3e0E44D2542EC3e79e3864Ae93Ef0B` |

- PoolAddressesProvider: `bgd-labs/aave-address-book` at commit `d4c2848e`, files `src/AaveV3Base.sol`, `AaveV3Arbitrum.sol` and `AaveV3BaseSepolia.sol`. On each fork `provider.getPool()` returns the section 3 Pool, and `Pool.ADDRESSES_PROVIDER()` returns the provider.
- Uniswap v3 factory: the official tables at `developers.uniswap.org/docs/protocols/v3/deployments`, v3-core 1.0.0. On chain each has 24,535 bytes of code and tick spacings 1, 10, 60 and 200 for fees 100, 500, 3000 and 10000.
- Base Sepolia NonfungiblePositionManager `0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2`, from the same table. Its `factory()` returns the factory above.
- QuoterV2: Uniswap's deployments feed, `developers.uniswap.org/deployments.json`, generated on 2026-11-04 from `Uniswap/contracts` at commit `036160f7`, which the deployments page links to. Read on 2026-11-08 with `cast` at the pinned blocks: each has 8,273 bytes of code, `factory()` returns the factory above and `WETH9()` the chain's WETH. On Base and Arbitrum it quoted 10,000 USDC out of the 0.05% pool at 4.453 WETH; on Base Sepolia, where the 0.30% pool is unseeded at that block, it reverted, and on the fork it quotes the seeded pool. `test_chainFacts` checks code, factory and WETH on every fork, and every keeper-sized unwind checks a quote against the sale. `Deployments.quoterV2` holds them.
- Base Sepolia market: WETH is the chain's WETH9 predeploy `0x4200000000000000000000000000000000000006`, and USDC is Aave's test token `0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f`. The test token's `owner()` is Aave's faucet `0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc`, whose `getTokenConfig(USDC)` read 3,600 seconds and 1,000,000 tokens: one mint an hour per address, up to a million test USDC.
- At the pinned Base Sepolia block every fee tier for this pair already had a pool, at prices others had left: 0.01% at 0.98 of the oracle price, 0.05% at the bottom of its range, 0.30% at 0.60 and 1% at 1.34.
- Arbitrum Sepolia market, read on 2026-11-11: Pool `0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff`, revision 3, with two reserves. USDC is Circle's testnet token `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`, a FiatToken that only Circle can mint, so there is no faucet a script can call. WETH is Aave's own wrapper `0x1dF462e2712496373A347f8ad10802a5E95f053D`, with `deposit()`, at LTV 75% and a 78% liquidation threshold; Uniswap's WETH9 there is a different contract, `0x980B62Da83eFf3D4576C647993b0c1D7faf17c73`. The provider and pool are not in the address book at the commit above; `provider.getPool()` returns the Pool and `Pool.ADDRESSES_PROVIDER()` the provider. NonfungiblePositionManager `0x6b2937Bde17889EDCf8fbD8dE31C3C2a70Bc4d65`, whose `factory()` is the factory above. QuoterV2 has 8,273 bytes of code and `factory()` returns the factory above. Every fee tier for WETH/USDC had a pool: the 0.30% one was empty and priced near zero, the 0.05% and 1% ones held under 1 USDC and 158 USDC of others' liquidity.

## Scripts

Neither script sends anything unless run with `--broadcast`. Run it without first: Foundry simulates against the live chain and prints what it would send.

### DeployUnwind

Deploys `LeveeUnwind` with the constructor arguments for the chain the RPC serves, which must be Base, Arbitrum One, Base Sepolia or Arbitrum Sepolia. It signs with `DEPLOYER_PRIVATE_KEY` if that is set, and otherwise with Foundry's wallet flags.

Base Sepolia, from the test EOA in the repo root's gitignored `.env.testnet-evm`:

```sh
cd evm
set -a; . ../.env.testnet-evm; set +a
DEPLOYER_PRIVATE_KEY="$TEST_EOA_PRIVATE_KEY" forge script script/DeployUnwind.s.sol --rpc-url https://sepolia.base.org
DEPLOYER_PRIVATE_KEY="$TEST_EOA_PRIVATE_KEY" forge script script/DeployUnwind.s.sol --rpc-url https://sepolia.base.org --broadcast
```

Base or Arbitrum mainnet, from a Foundry keystore rather than a key in the environment:

```sh
forge script script/DeployUnwind.s.sol --rpc-url "$BASE_RPC" --account levee-deployer --broadcast
```

Funds: ETH for about 2.2M gas. Nothing else.

### SeedTestnetPool

Moves the Uniswap v3 pool for an Aave testnet market's WETH and USDC to Aave's oracle price and adds a position around it, so `unwind` can run live. It runs on Base Sepolia and Arbitrum Sepolia. Every tier for the pair already exists, so the script swaps the pool to the oracle price with a small `PoolPriceMover` contract it deploys. SwapRouter02 cannot do this, because it refuses a swap across an empty range. The script then mints a position with the official NonfungiblePositionManager, owned by the deployer. It reads the key from `TEST_EOA_PRIVATE_KEY` and does not print it.

```sh
cd evm
set -a; . ../.env.testnet-evm; set +a
forge script script/SeedTestnetPool.s.sol --rpc-url https://sepolia.base.org
forge script script/SeedTestnetPool.s.sol --rpc-url https://sepolia.base.org --broadcast
```

| Variable | Default | Meaning |
|---|---|---|
| `TEST_EOA_PRIVATE_KEY` | required | Deployer key |
| `SEED_POOL_FEE` | `3000` | Fee tier. The position's `pool_fee` must match |
| `SEED_WETH_WEI` | 0.2 WETH | WETH for the position |
| `SEED_USDC_UNITS` | the oracle value of the WETH | Test USDC for the position, 6 decimals |
| `SEED_RANGE_TICKS` | `600` | Half-width of the position, about 6% each side |
| `SEED_GAS_RESERVE_WEI` | 0.005 ETH | ETH kept for gas when wrapping |
| `PRICE_MOVER` | none | A `PoolPriceMover` from an earlier run, to reuse. The script logs its address |

Funds and test tokens:

- Base Sepolia ETH for `SEED_WETH_WEI` plus gas. A first run on the fork used 1.46M execution gas over about a dozen transactions, so budget 2M. The first live run sent 11 transactions for 1,466,132 gas. The script wraps any WETH it lacks from the deployer's ETH and keeps the gas reserve.
- On Base Sepolia, test USDC comes from Aave's faucet. The script asks it for any shortfall plus 10,000, which pays for moving the price up. The faucet allows one mint an hour per address, so a second run inside the hour needs the USDC already in the wallet. Otherwise it stops with `faucet timelock: wait an hour or lower SEED_USDC_UNITS`.
- On Arbitrum Sepolia, the market's USDC is Circle's and has no faucet a script can call, so the deployer must hold `SEED_USDC_UNITS` first, and at least one base unit, which moving the empty pool's price needs. Otherwise the script stops with `no USDC faucet on this chain: hold SEED_USDC_UNITS of USDC first, e.g. borrowed on Aave`. Borrow it on Aave against WETH, as `test_seed_liveFunding_borrowsUsdcOnAave` rehearses:

  ```sh
  # Once: cast wallet import levee-test --interactive   (the test EOA, into a Foundry keystore)
  RPC=https://sepolia-rollup.arbitrum.io/rpc
  POOL=0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff
  WETH=0x1dF462e2712496373A347f8ad10802a5E95f053D
  USDC=0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d
  ME=$(cast wallet address --account levee-test)
  cast send $WETH "deposit()" --value 0.15ether --account levee-test --rpc-url $RPC
  cast send $WETH "approve(address,uint256)" $POOL 0.1ether --account levee-test --rpc-url $RPC
  cast send $POOL "supply(address,uint256,address,uint16)" $WETH 0.1ether $ME 0 --account levee-test --rpc-url $RPC
  cast send $POOL "borrow(address,uint256,uint256,uint16,address)" $USDC 60000000 2 0 $ME --account levee-test --rpc-url $RPC
  set -a; . ../.env.testnet-evm; set +a   # the seed script itself reads TEST_EOA_PRIVATE_KEY
  SEED_WETH_WEI=20000000000000000 SEED_USDC_UNITS=40000000 forge script script/SeedTestnetPool.s.sol --rpc-url $RPC
  ```

  Then run it again with `--broadcast`.
- At the pinned block the 0.30% pool held 0.42 WETH and 497 test USDC of other people's liquidity. Moving its price up to the oracle buys at most that WETH, for test USDC.

The defaults put 0.2 WETH and about 450 test USDC in a 6% range. By that position's virtual reserves, not measured, a 50 USDC unwind would cost about 0.65% with the fee, so keep live unwinds to tens of USDC under a 100 bps bound, or seed more. The oracle tracks the real ETH price and nobody arbitrages this pool back to it, so run the script again shortly before each live unwind. A rerun moves the price through the existing position and adds to it. `UnwindBaseSepoliaTest` runs the same script before every test, from an address that holds only ETH, and `UnwindArbitrumSepoliaTest` from one given USDC with `deal`.

Once the pool sits at the oracle price, other people's small swaps of test ETH for USDC go through it too, and each unwind is itself a sale. Live, it read 40 to 90 bps under the oracle within minutes of a recentring, so rerun the script with a small `SEED_WETH_WEI`, such as 0.001 WETH, right before each unwind.

## Base Sepolia deployment

Deployed and seeded on 2026-11-08 from the test EOA `0x1BA01ceF25983F71e508f139Ecb10030b0403331`, with the two scripts above. Hashes were read back from the chain.

| Item | Value |
|---|---|
| `LeveeUnwind` | [`0x308a7b2872F6006522280026a750fCD1c5Bd63D2`](https://sepolia.basescan.org/address/0x308a7b2872F6006522280026a750fCD1c5Bd63D2) |
| Deployment | [`0x9fc55b10…5e89`](https://sepolia.basescan.org/tx/0x9fc55b101d63e17e51e624cf22f64302a39a64d26e89f725a71ef2582f375e89), block 56,051,013, 2,198,239 gas |
| Source | [Sourcify, exact match](https://repo.sourcify.dev/84532/0x308a7b2872F6006522280026a750fCD1c5Bd63D2) of this directory's `src/LeveeUnwind.sol`, solc 0.8.30, 200 runs, Cancun |
| Constructor, read back | `ADDRESSES_PROVIDER()` `0xE4C23309117Aa30342BFaae6c95c6478e0A4Ad00`, whose `getPool()` is the section 3 Pool; `USDC()` `0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f`; `UNISWAP_V3_FACTORY()` `0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24`, 24,535 bytes, tick spacings 1, 10, 60, 200 |
| Pool | WETH/USDC 0.30% [`0x92266210FacF124f190fbad79AA230dfB85926Ce`](https://sepolia.basescan.org/address/0x92266210FacF124f190fbad79AA230dfB85926Ce), `pool_fee` 3000 |
| `PoolPriceMover` | `0x102515C4f468Fe26b99cEa5Da1A2Be56865EE2F1`, deployed by the first seed run and reused |

Blockscout's verifier answered `Unable to verify` for the same input, and then rate-limited further attempts, so the verified source is on Sourcify.

Seed runs. The first bought 0.2137 WETH of other people's liquidity for 157.69 test USDC while moving the pool from 252 to the oracle's 2,234.42 USDC per WETH; that WETH paid for the second run and for the borrower's collateral. Every later run first moved the price back, since others had traded through the pool in between.

| Run | `SEED_WETH_WEI` | `moveTo` | Mint | Position |
|---|---|---|---|---|
| First, block 56,052,361 | 0.002 WETH, 0.002 ETH wrapped | [`0x7d1bdd1f…631f`](https://sepolia.basescan.org/tx/0x7d1bdd1fc25c5a53099a710779f61edac0fdc9add143b2d0ddb2eeb53ea9631f) | [`0xa50c9808…fd70`](https://sepolia.basescan.org/tx/0xa50c980847beb356c9674d6bc5190649b846897106a9a4964e8c4cf18d86fd70) | 84797 |
| Second, block 56,052,754 | 0.1 WETH, from the wallet | [`0x2123ce8c…0114`](https://sepolia.basescan.org/tx/0x2123ce8c7e2e6775d8dba68409f752227a12f4f991ac09d2bc2ca3137bcd0114) | [`0xb925fc71…59ec`](https://sepolia.basescan.org/tx/0xb925fc71cd6a37a9fc227690f918680c8dcbdaead1e8d20018d80c734b9d59ec) | 84798, 0.0918 WETH and 223.44 USDC |
| Before rescue 1, block 56,054,620 | 0.001 WETH | [`0x1a02211d…62a3`](https://sepolia.basescan.org/tx/0x1a02211d36e48f1c426f23c99a22a6b6e50ec0fe6ffb0fc4a5d7a381261f62a3) | [`0x0eb8c1e5…8c4e`](https://sepolia.basescan.org/tx/0x0eb8c1e5a4171c9b27efbd23f80c7f06639ff3077198d0896cb94d580d8c8c4e) | 84799 |
| Before rescue 2, block 56,054,998 | 0.001 WETH | [`0xf6958cb0…24aa`](https://sepolia.basescan.org/tx/0xf6958cb02cbd49650c8c8ac5c6311d36983a2b7ce59a28c77b432ca9ce6024aa) | [`0x3aa16ae1…cef5`](https://sepolia.basescan.org/tx/0x3aa16ae15cef2fa3e109fca29bca84b1ae9e6f3d6eb3a2c995d3c7f559bbcef5) | 84800 |
| Before rescue 3, block 56,055,293 | 0.001 WETH | [`0x7504a5df…1be6`](https://sepolia.basescan.org/tx/0x7504a5df7f3cd15a75a7f95c6528e50dd161fc306cd9ffe56a32c19e92f61be6) | [`0x52378142…98c0`](https://sepolia.basescan.org/tx/0x52378142dd66d85b1b907f307fe4fda55410d334d0c33685187a4098e68898c0) | 84801 |
| Before rescue 4, block 56,055,688 | 0.001 WETH | [`0x12f76abf…db69`](https://sepolia.basescan.org/tx/0x12f76abfdda8c06b21825025be49450f2be1b3dcdcf58298dd5e7664d983db69) | [`0x89caa41e…df89`](https://sepolia.basescan.org/tx/0x89caa41e21f001c760fddaea48cec4c2ee9aed669556a06119d3eb210273df89) | 84802 |
| Before rescue 5, block 56,056,616 | 0.001 WETH | [`0xbf086efd…db6f`](https://sepolia.basescan.org/tx/0xbf086efdc1c0d2010139ef14ce32abd41986fe1814de49bc7b26eb5a3d44db6f) | [`0xa4c63be4…ae46`](https://sepolia.basescan.org/tx/0xa4c63be4abb55597dcbf41cf79ec123b60dc35dae825cd571b989a134b14ae46) | 84803 |

The pool is ours and seeded at the oracle price, so what an unwind paid in it is not a measure of slippage. The borrower's setup, the rescues and their NEAR side are in `docs/SPEC.md` section 9, "Testnet", and `contracts/README.md`.

| Borrower step | Transaction |
|---|---|
| Approve and supply 0.035 WETH to Aave, on top of 0.015 already supplied | [`0xe2717a1c…af77`](https://sepolia.basescan.org/tx/0xe2717a1cd072293c73f8fb58ba8fa461b6cc19ba32732019c9694df729fdaf77), [`0xbd392996…b1b1`](https://sepolia.basescan.org/tx/0xbd3929965a319c52c0bb0ddf238f9a4b5fc38285eeceeb0f15b7f081ea97b1b1) |
| `authorize(0x95ad…c462, 100, 1.5e18, 1.8e18, WETH, 3000)` | [`0x4b2f1a52…781a`](https://sepolia.basescan.org/tx/0x4b2f1a52846f3244d337a371c8f378fb5af8b355f1488017c965813bbd1d781a) |
| Approve 0.04 aWETH (`0x73a5bB60b0B0fc35710DDc0ea9c407031E31Bdbb`) to the helper | [`0x769eb78d…3d42`](https://sepolia.basescan.org/tx/0x769eb78d01af8e5b16c4a663ed27f1b8781d3a0b81a49b0e942efc9929383d42) |
| 0.0015 ETH to the rescuer for gas | [`0xdadbf319…1655`](https://sepolia.basescan.org/tx/0xdadbf31957e0d46bf47bfa28f97ecad34194f3f03a655166ad5689b03f941655) |
| Borrows that took the health factor to 1.48 before each attempt | [`0x97bddc04…2e99`](https://sepolia.basescan.org/tx/0x97bddc04632626cfeb3b539b62e8be06c18500e3057327b338d6570ccb272e99), [`0xd991e429…1802`](https://sepolia.basescan.org/tx/0xd991e429bad8e0dbfe7d02d26e3e05bd9eb4519c2fb3a9602491850ea25e1802), [`0x7a232145…a02f`](https://sepolia.basescan.org/tx/0x7a232145eff0a912e1d556e8e51e50d62cb5b3fec3b90ac730841b342931a02f), [`0xaf8bda8c…f733`](https://sepolia.basescan.org/tx/0xaf8bda8c79f1d53d3e9c46c13ec154caf77e9ae75ec0e20ac4bc5a2cf236f733), [`0x2b49a1ae…8bd2`](https://sepolia.basescan.org/tx/0x2b49a1ae9a91123b0d1e7c9e0bb66cc5b05c362748acfa80ec2b270b03d28bd2) |


## Two-chain deployment

On 2026-11-11, from `develop` at `7b23c77`, for the NEAR contract `levee-v2-multi-1503.testnet`, which lists both chains (`contracts/README.md`, "v0.2 on two chains"). The work was signed by a new test EOA, `0xDb6A55bf949E488cb42BAD27C4714220100F3793`, whose key is only in the gitignored `.env.testnet-evm`. It also borrows on both chains. Hashes were read back from the chains.

Funding came as Ethereum Sepolia ETH, bridged through each chain's official contracts after checking them against the chains' docs and on chain:

| Bridge | Transaction | Arrived |
|---|---|---|
| 0.045 ETH to Base Sepolia, `L1StandardBridge.depositETH` at `0xfd0Bf71F60660E2f608ed56e1659C450eB113120` | [`0xb460559b…ee8a`](https://sepolia.etherscan.io/tx/0xb460559b5722f0360aef6d6aa44d348673cc47a58f53e26b1243a7cfda1fee8a) | after about 5 minutes |
| 0.05 ETH to Arbitrum Sepolia, `Inbox.depositEth` at `0xaAe29B0366299461418F5324a79Afc425BE5ae21` | [`0x1c0e903b…b990`](https://sepolia.etherscan.io/tx/0x1c0e903b147acebba61a83559cc3573c78c0f1f9f49992b791332a71affbb990) | after about 11.5 minutes |

`LeveeUnwind` with the Aave v3.0 fix landed at the same address on both chains, the same deployer at nonce 0, and Sourcify matches it exactly to this directory's source on both:

| Chain | `LeveeUnwind` | Deployment | Source |
|---|---|---|---|
| Base Sepolia | [`0xD9a54F7743B5BbA3fdC77c96b932f50ce67177e8`](https://sepolia.basescan.org/address/0xD9a54F7743B5BbA3fdC77c96b932f50ce67177e8) | [`0xa7ac24df…f0bb`](https://sepolia.basescan.org/tx/0xa7ac24df167585f5ec43bc5cabacfb3c19d97cce72db6a7d39af03dd91e8f0bb), block 57,531,197, 2,268,039 gas | [Sourcify](https://repo.sourcify.dev/84532/0xD9a54F7743B5BbA3fdC77c96b932f50ce67177e8) |
| Arbitrum Sepolia | [`0xD9a54F7743B5BbA3fdC77c96b932f50ce67177e8`](https://sepolia.arbiscan.io/address/0xD9a54F7743B5BbA3fdC77c96b932f50ce67177e8) | [`0x8c1bd728…7291`](https://sepolia.arbiscan.io/tx/0x8c1bd728d8639698818b05c0dad91d14ea6387d5940850621ca2a146362a7291), block 328,292,187, 2,269,154 gas | [Sourcify](https://repo.sourcify.dev/421614/0xD9a54F7743B5BbA3fdC77c96b932f50ce67177e8) |

Each constructor's three values were read back and matched `Deployments.unwindArgs`.

### Pools

Both are 0.30% WETH/USDC pools that `SeedTestnetPool` moved to the oracle price and then added a position to, `SEED_RANGE_TICKS` 120, about 1.2% either side.

| Chain | Run | Move | Mint | Position |
|---|---|---|---|---|
| Base Sepolia | First. The pool had drifted to tick -230,601, about $0.10 per WETH, against an oracle of $2,081. The move bought 0.395 WETH of others' liquidity for faucet USDC. `PRICE_MOVER` `0x102515C4…E2F1` | [`0x6f3784f0…d68a`](https://sepolia.basescan.org/tx/0x6f3784f0379468a09825561d875b3d390a30ac40805a68e3bbb659bd3291d68a) | [`0xab9e6445…c21a`](https://sepolia.basescan.org/tx/0xab9e6445c5c861e8b4158d864a2e0f6cd14353062c400c391270a210b5dac21a) | 84973, 0.01 WETH and 15.66 USDC |
| Base Sepolia | Before the second pair, 62 bps under the oracle | [`0x83b4348c…0ee4`](https://sepolia.basescan.org/tx/0x83b4348c5aa4f1e08481fa3b2974944b07de59f66e1422f81c3abc6577750ee4) | [`0x21a8260d…cb21`](https://sepolia.basescan.org/tx/0x21a8260dc952053fa2368f03fcfa841dd38b58a3b569040ed7275fe12129cb21) | 0.001 WETH |
| Arbitrum Sepolia | First. The pool was empty, priced near zero. It deployed `PoolPriceMover` `0x531Fc7F162Efdcc43512E09DB28d429CdEe87Fe7` in [`0xa2fa40b0…9970`](https://sepolia.arbiscan.io/tx/0xa2fa40b0ddaac21fa3e6f2b0ac1b4aa169125ab09595586bbc2b62e6771a9970) | [`0x30da1971…3895`](https://sepolia.arbiscan.io/tx/0x30da1971e359f06f1c286eb7748ed976cc4b4e55838ee375b12e634ad5c33895) | [`0xc57462dc…972f`](https://sepolia.arbiscan.io/tx/0xc57462dc56efaa7615c144e8543ec922895cefece6d64839c053733a50ee972f) | 4132, 0.013 WETH and 18.25 USDC borrowed on Aave |
| Arbitrum Sepolia | Before the second pair, 40 bps under the oracle | [`0x7a71b920…f0f9`](https://sepolia.arbiscan.io/tx/0x7a71b920cfec81fbc321748729bb7b5585f46900210c768f0e68ff93607df0f9) | [`0x903bdfb3…34e4`](https://sepolia.arbiscan.io/tx/0x903bdfb3b3518df82da3edd044c0323c8bc1a1b805e987f9f7632147456534e4) | 0.001 WETH |

### Borrower

The same EOA borrows on both chains. Each `authorize` names that chain's rescuer from the NEAR contract and sets trigger 1.5, target 1.6, 100 bps, WETH and fee 3000.

| Step | Base Sepolia | Arbitrum Sepolia |
|---|---|---|
| Wrap ETH | done by the seed run | 0.045 ETH, [`0x0dfa3d0a…2aa3`](https://sepolia.arbiscan.io/tx/0x0dfa3d0ac1688f8e73f9e8c43598e1eb347fa8a9933744cf12ad397bd8d62aa3) |
| Approve WETH to Aave | [`0x24f9449d…df0d`](https://sepolia.basescan.org/tx/0x24f9449db22c30b3d4b6a931cc385fba221f71da25738828c4a38bc0ef20df0d) | [`0x4d5d8c1c…816e`](https://sepolia.arbiscan.io/tx/0x4d5d8c1c6ead2519de5a2cb6bcfaffa434550f6b59aeb22cf4d1e6b791dd816e) |
| Supply WETH | 0.04, [`0x572c571c…79b9`](https://sepolia.basescan.org/tx/0x572c571c30abbb7e91d004c1de29d2ba62df4f3ee39f3fed3ac6f300ecc179b9) | 0.03, [`0xb2bb2626…bfb3`](https://sepolia.arbiscan.io/tx/0xb2bb262612ff312bb440d2fedd08f0f8950634c2e9b02b4b2b4419e3c7afbfb3) |
| Borrow USDC for the pool | none, faucet USDC | 28 USDC, [`0x67f76f4e…3a34`](https://sepolia.arbiscan.io/tx/0x67f76f4e6a526099cdeb920ed9d984c1f43aca9060c29f6f60a305f5be483a34) |
| `authorize` | rescuer `0x6d65…0295`, [`0xcf8f24e0…6dc8`](https://sepolia.basescan.org/tx/0xcf8f24e0118982f901ec8633fd143e6f09beafc3520ca6588f4fbdc182ff6dc8) | rescuer `0x0084…9403`, [`0x2ccb3cdd…f9b1`](https://sepolia.arbiscan.io/tx/0x2ccb3cdd3ef39b73979a6f3957edba3524708ae8cf740f4a7fc2e6223694f9b1) |
| Approve aWETH to the helper | 0.04 of `0x73a5…Bdbb`, [`0xf985b76d…67ba`](https://sepolia.basescan.org/tx/0xf985b76d042eb796836ead82d69df76e3bdc7490889f7c26a27ede1f0fc967ba) | 0.03 of `0xf5f1…CE60`, [`0xf9e69653…daca`](https://sepolia.arbiscan.io/tx/0xf9e696534f459622e41905993f24191b3cd85914d60b682634ec05e55bdbdaca) |
| Gas to the rescuer | 0.002 ETH, [`0xbabaaad9…b579`](https://sepolia.basescan.org/tx/0xbabaaad90d72a5680ae02c57b2983f5d6b9ec23755ef26f3c1076e523484b579) | 0.0015 ETH, [`0x372b9bb1…dde9`](https://sepolia.arbiscan.io/tx/0x372b9bb1f77d5a72e54c61c316d84007d19e146df7736bd675d1d1e2ee8cdde9) |
| Borrow to health factor 1.45, first pair | 48.8 USDC, [`0xaaff6cec…ece6`](https://sepolia.basescan.org/tx/0xaaff6cec8e245e357e97094207b1e98274f324340c759cd6c537cb26e150ece6) | 5.6 USDC, [`0xcf3c3066…9e06`](https://sepolia.arbiscan.io/tx/0xcf3c30667ba9d210487eafe6be419bdca9e3c682ff314fb0f3e35bf3b2bc9e06) |
| Borrow to health factor 1.45, second pair | 3.99 USDC, [`0xa077f1ad…a82d`](https://sepolia.basescan.org/tx/0xa077f1ad10e78262859908f0e8f7fe17061bb90d7b296d088e9644c5d704a82d) | 2.83 USDC, [`0x62615334…9663`](https://sepolia.arbiscan.io/tx/0x62615334f6d65ed6463c0e0d820891f50bc5b552047beae9e265d5e1d2569663) |

The four unwinds are in `evidence/runs/` and `docs/SPEC.md` section 9, "One contract, two chains". As before, the pools are ours, so what the sales paid is not a measure of slippage.
