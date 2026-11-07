# Levee EVM fork tests

Foundry tests against the live Aave v3 deployments at pinned blocks. They use the deployed bytecode, not a vendored copy, so a change in Aave's behaviour fails a test here. Nothing is sent to a real chain: mainnet is only read to build the fork.

## Run

Needs Foundry 1.5.1. From the repo root:

```sh
git submodule update --init evm/lib/forge-std
cd evm
forge test -vv
```

One suite at a time:

```sh
forge test -vv --match-contract BaseRepayTest
forge test -vv --match-contract ArbitrumRepayTest
forge test -vv --match-contract BaseCrashTest
```

The crash comparison prints its table with:

```sh
forge test -vv --match-test test_crash_printsTheDifference
```

The first run pages state in from public RPCs and took about 20 seconds when measured. Foundry caches it under `~/.foundry/cache`, and later runs take about a second. To check a cold run without clearing that cache:

```sh
forge test --no-storage-caching
```

## RPC endpoints

| Variable | Default | Used for |
|---|---|---|
| `BASE_FORK_RPC_URL` | `https://mainnet.base.org` | `BaseRepayTest`, `BaseCrashTest` |
| `ARBITRUM_FORK_RPC_URL` | `https://arbitrum-one.public.blastapi.io` | `ArbitrumRepayTest` |

No API key is needed. Set a variable to use your own archive endpoint. A fork that lands on the wrong chain or block fails in `setUp` rather than passing quietly.

## Pinned blocks

| Chain | Block | Timestamp | Pool revision |
|---|---|---|---|
| Base | 54,260,000 | 1794042375 | 11 |
| Arbitrum One | 522,040,000 | 1794041907 | 11 |

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
| Allowance below the amount | Reverts, nothing moves |
| Debt right after borrowing | 1 base unit above the amount borrowed, on both chains |

Two results changed the keeper:

- **The bare formula lands short.** Rounded up to a whole USDC base unit, the repay reached 1.749999999925 against a target of 1.75 on Base. Aave burns scaled debt rounding down and reads the balance rounding up, so a repay of `R` can remove about 2 base units less than `R`. With 2 base units added it reached 1.750000000250 on Base and 1.750000000209 on Arbitrum. The spec and `keeper/src/decision.ts` both add them.
- **USDC is not priced at $1.** The oracle read 0.99975 on Base and 0.9998773 on Arbitrum at these blocks, so the repay is converted at the oracle price.

## Gas

`repay` used about 160,000 gas on both chains, not counting the 21,000 intrinsic cost. That is 158,745 on Base and 160,254 on Arbitrum, measured with cold storage:

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
