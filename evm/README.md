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
| `BASE_FORK_RPC_URL` | `https://mainnet.base.org` | `BaseRepayTest`, `BaseCrashTest`, `UnwindBaseTest` |
| `ARBITRUM_FORK_RPC_URL` | `https://arbitrum-one.public.blastapi.io` | `ArbitrumRepayTest`, `UnwindArbitrumTest` |
| `BASE_SEPOLIA_FORK_RPC_URL` | `https://sepolia.base.org` | `UnwindBaseSepoliaTest` |

No API key is needed. Set a variable to use your own archive endpoint. A fork that lands on the wrong chain or block fails in `setUp` rather than passing quietly.

## Pinned blocks

| Chain | Block | Timestamp | Pool revision |
|---|---|---|---|
| Base | 54,260,000 | 1794042375 | 11 |
| Arbitrum One | 522,040,000 | 1794041907 | 11 |
| Base Sepolia | 56,000,000 | 1794121868 | 10 |

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
function authorize(address rescuer, uint16 maxSlippageBps, uint64 triggerHf, uint64 targetHf) external;
function revoke() external;
function authorizationOf(address borrower) external view
    returns (address rescuer, uint16 maxSlippageBps, uint64 triggerHf, uint64 targetHf);
// Only the borrower's rescuer, only while the health factor is below the trigger.
function unwind(address borrower, address collateral, uint256 amount, uint24 poolFee)
    external returns (uint256 repaid, uint256 sold);

event Authorized(address indexed borrower, address indexed rescuer, uint16 maxSlippageBps, uint64 triggerHf, uint64 targetHf);
event Revoked(address indexed borrower, address indexed rescuer);
event Unwound(address indexed borrower, address indexed rescuer, address indexed collateral, uint256 repaid, uint256 sold);
```

| Call | Selector |
|---|---|
| `unwind(address,address,uint256,uint24)` | `0xd0cda3c2` |
| `authorize(address,uint16,uint64,uint64)` | `0x544fc06e` |
| `revoke()` | `0xb6549f75` |

`test_chainFacts` asserts all three. The constructor takes the Aave `PoolAddressesProvider`, USDC and the Uniswap v3 factory. The Pool and the oracle are read from the provider on every call.

### What `unwind` does

1. Refuses a re-entered call, a caller who is not the borrower's rescuer, a zero amount, and USDC as collateral.
2. Reads the health factor from `Pool.getUserAccountData` and refuses it at or above the borrower's trigger.
3. Refuses collateral that is not an Aave reserve, or is inactive, frozen or paused. Caps `amount` at the USDC variable debt.
4. Computes `maxIn = amount * price(USDC) / price(collateral) * (1 + maxSlippageBps)` in collateral base units from Aave's oracle, with one `mulDiv` that rounds down. Both prices are in the oracle's base currency, so its unit cancels. The decimals come from Aave's reserve configuration.
5. Looks the pool up with `factory.getPool(collateral, USDC, poolFee)` and starts an exact-output swap for `amount` USDC to itself, with the price limit at the end of the range.
6. In the callback, accepts only the pool it is swapping on, once: the pool address sits in transient storage and the callback clears it on entry. It requires exactly `amount` USDC received and collateral owed of at most `maxIn`. It repays `amount` with `Pool.repay(USDC, amount, 2, borrower)`, pulls the owed aTokens from the borrower with `transferFrom`, and withdraws its whole aToken balance from Aave to the pool.
7. Reads the health factor again. It must have risen, and must not exceed the bound below.

`maxSlippageBps` is all in: the pool fee counts against it. A 0.30% pool leaves 70 bps of a 100 bps bound for price impact and for the pool's distance from the oracle.

### The post-check bound

The keeper sizes the repay for the worst cost it allows, `s_w = maxSlippageBps + poolFee`, with section 9's `R = (T*D - C*L) / (T - L_c*(1 + s_w))`. If the swap actually costs `s`, the health factor lands at

```
HF_after = T + R * L_c * (s_w - s) / D_after
```

with `L_c` the collateral's liquidation threshold and `D_after` the debt left, both from Aave. `R * (s_w - s)` is what a worst-case swap would have spent less what this one did, which the helper knows exactly from the oracle and the swap. Taking `L_c` as 1 gives a bound that needs no reserve parameters and uses Aave's own account data, so Aave handles eMode and several collaterals:

```
bound = T * (1 + 1%) + (repaid * price(USDC) * (1 + s_w) - sold * price(collateral)) / D_after
```

The 1% (`HF_MARGIN_BPS`) covers rounding in Aave's account data and an oracle update between the keeper's read and the transaction. A repay of the whole debt leaves an unbounded health factor and does not pass: no target up to 3.0 needs one. `test_unwind_overSaleHeadroom_isSmall` finds by bisection how far past the keeper's own amount a sale can go:

| Fork, pool | Largest sale allowed |
|---|---|
| Base, 0.30% | 1.0117 x the keeper's amount |
| Arbitrum, 0.05% | 1.0121 x |
| Base Sepolia, seeded 0.30% | 1.0117 x |

### Tests

`test/lib/UnwindPath.sol` runs unchanged on all three forks, through `UnwindBase.t.sol`, `UnwindArbitrum.t.sol` and `UnwindBaseSepolia.t.sol`. Every test that reaches the helper ends by asserting that it holds no USDC, WETH, aWETH, scaled aWETH, debt, USDC allowance or ETH.

| Test | Shows |
|---|---|
| `test_unwind_deepestPool_fromNearLiquidationToTarget` | 10 WETH at HF 1.05, a keeper-sized unwind to 1.5 on the deepest pool. Checks the event, the return values, debt, aWETH, allowance, both pool balances, the oracle bound, wallets, HF against a repay-then-sell model, and the post-check bound, all from reads that do not go through the helper |
| `test_unwind_otherPool_fromNearLiquidationToTarget` | The same on the second real fee tier |
| `test_unwind_justBelowTrigger_succeeds`, `test_unwind_aboveTrigger_reverts`, `test_unwind_withNoDebt_isAboveTrigger` | The trigger |
| `test_unwind_largeOverSale_isBlocked`, `test_unwind_overSaleHeadroom_isSmall` | The post-check |
| `test_unwind_amountAboveDebt_isCappedThenBlocked` | The cap holds, the full repay it makes is refused, and nothing moves |
| `test_authorize_*`, `testFuzz_authorize_healthFactorBounds` | Storage, events, `revoke`, every rejected value and the edges |
| `test_unwind_byAnyoneButTheRescuer_reverts`, `test_unwind_afterRevoke_reverts`, `test_unwind_afterAllowanceRemoved_reverts` | Who can call, and both ways to stop it |
| `test_unwind_slippageBoundBelowPoolCost_reverts` | A 1 bp bound against a real pool fee |
| `test_unwind_poolPushedOffOracle_reverts` | A whale sale moves the pool 3% before the unwind |
| `test_unwind_feeTierWithNoPool_reverts`, `test_unwind_poolTooThin_reverts` | No pool for the tier, and a real pool, created by the factory owner on the fork, too thin for the amount |
| `test_unwind_allowanceTooSmall_reverts`, `test_unwind_collateralBalanceTooSmall_reverts` | The borrower's limits |
| `test_unwind_zeroAmount_reverts`, `test_unwind_wrongCollateral_reverts` | Inputs |
| `test_callback_fromFakePool_reverts`, `test_callback_fromTheRealPoolWithNoUnwind_reverts` | Spoofed callbacks |
| `test_reentrancy_throughCollateralToken_isRefused` | The real WETH code is wrapped in place by a token that, while Aave pays the pool, tries to unwind a second borrower who authorized it, then calls the callback. It gets `Reentrancy()` and `UnexpectedCallback()`, and the honest unwind's numbers are exact |
| `test_unwind_frozenCollateral_reverts`, `test_unwind_pausedCollateral_reverts` | As pool admin on the fork. Aave alone still lets frozen WETH be withdrawn |
| `test_unwind_isolationModeBorrower` | Revision 10 only: a debt ceiling written into WETH's configuration, a borrower in isolation mode, and an unwind that releases the ceiling. Skipped on revision 11, which has no isolation mode |
| `testFuzz_unwind_amountAndSlippage`, `testFuzz_unwind_triggerAndTarget` | 256 runs each per fork, every run held to the happy path's checks |
| `test_constructor_rejectsWrongArguments` | Deployment checks |

Base Sepolia adds `test_baseSepolia_isPoolRevision10`, `test_seed_putsThePoolAtTheOraclePrice`, `test_seed_rerun_followsTheOracle`, `test_seed_rerunInsideFaucetTimelock_saysWhy` and `test_wrongFeeTier_stalePools_revert`.

### Recorded results

10 WETH at HF 1.05, trigger 1.2, target 1.5, slippage bound 100 bps.

| Fork, pool | Repaid USDC | Sold WETH | Cost against oracle | HF after |
|---|---|---|---|---|
| Base, 0.30% (deepest) | 12,461.23 | 5.573707 | 49.4 bps | 1.5153 |
| Base, 0.05% | 12,421.05 | 5.531853 | 6.2 bps | 1.5186 |
| Arbitrum, 0.05% (deepest) | 12,423.54 | 5.532317 | 7.0 bps | 1.5184 |
| Arbitrum, 0.30% | 12,463.73 | 5.578282 | 57.6 bps | 1.5137 |
| Base Sepolia, seeded 0.30% | 12,727.00 | 5.721938 | 36.2 bps | 1.5190 |

On Base the 0.30% pool holds the most in-range liquidity, 3.25e19 against 7.81e17, but for this size the 0.05% pool costs an eighth as much. The fee, not the depth, decides `pool_fee` at this size.

The health factor lands above the target because the keeper sized for a 130 or 105 bps cost and paid less. The Base Sepolia cost is the 0.30% fee plus impact on liquidity seeded at the oracle price, so it is not a measure of slippage.

### Gas

Cold storage, `forge test --isolate`:

| Fork, pool | `unwind` gas |
|---|---|
| Base, 0.30% | 560,129 |
| Base, 0.05% | 590,000 |
| Arbitrum, 0.05% | 574,916 |
| Arbitrum, 0.30% | 574,753 |
| Base Sepolia, seeded 0.30% | 524,288 |

`forge test --isolate --gas-report` gives 517,018 to 582,730 over the same calls. A `gas_limit_unwind` of 1,000,000 leaves about 70% headroom for the 63/64 rule in the nested Aave and Uniswap calls and for swaps that cross more ticks. On Arbitrum a transaction's gas also pays for its L1 data, which a fork does not model, so confirm that limit on testnet. Deployment simulated at 2.39M gas, Foundry's estimate with its margin, on all three chains.

```sh
forge test --isolate --match-test 'test_unwind_(deepest|other)Pool' -vv
```

### Recorded Aave and Uniswap behaviour

| Case | Result |
|---|---|
| `withdraw(asset, type(uint256).max, uniswapPool)` inside the swap callback | Works on revisions 10 and 11, and burns the whole scaled balance, so no aToken dust stays |
| aToken `transferFrom` | Aave rounds in the receiver's favour and spends the allowance by the sender's real balance change. Pool overpayment, aWETH lost beyond `sold`, and allowance spent beyond `sold` all stayed within 2 wei. The keeper should expect an allowance a few wei above what it plans to sell |
| Frozen reserve | Aave allows withdraw, and from v3.6 sets the reserve's LTV to 0. The helper refuses it, per section 9 |
| Isolation mode | Removed in Aave v3.7, Pool revision 11. On revision 10, Aave lets an isolated borrower be unwound and the repay releases the debt ceiling |
| An exact-output swap through an empty range | Fills what it can and stops at the price limit: `PartialFill` |
| A pool already at the bottom of its range | Uniswap reverts `SPL` |

## Verified addresses

Read on chain at the pinned blocks. `script/lib/Deployments.sol` holds them, and `test_chainFacts` checks them on every fork.

| Chain | Aave PoolAddressesProvider | Uniswap v3 factory | WETH/USDC pools by fee |
|---|---|---|---|
| Base | `0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D` | `0x33128a8fC17869897dcE68Ed026d694621f6FDfD` | 0.30% `0x6c561B446416E1A00E8E93E221854d6eA4171372`, 0.05% `0xd0b53D9277642d899DF5C87A3966A349A798F224` |
| Arbitrum One | `0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb` | `0x1F98431c8aD98523631AE4a59f267346ea31F984` | 0.05% `0xC6962004f452bE9203591991D15f6b388e09E8D0`, 0.30% `0xc473e2aEE3441BF9240Be85eb122aBB059A3B57c` |
| Base Sepolia | `0xE4C23309117Aa30342BFaae6c95c6478e0A4Ad00` | `0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24` | 0.30% `0x92266210FacF124f190fbad79AA230dfB85926Ce`, seeded by the script |

- PoolAddressesProvider: `bgd-labs/aave-address-book` at commit `d4c2848e`, files `src/AaveV3Base.sol`, `AaveV3Arbitrum.sol` and `AaveV3BaseSepolia.sol`. On each fork `provider.getPool()` returns the section 3 Pool, and `Pool.ADDRESSES_PROVIDER()` returns the provider.
- Uniswap v3 factory: the official tables at `developers.uniswap.org/docs/protocols/v3/deployments`, v3-core 1.0.0. On chain each has 24,535 bytes of code and tick spacings 1, 10, 60 and 200 for fees 100, 500, 3000 and 10000.
- Base Sepolia NonfungiblePositionManager `0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2`, from the same table. Its `factory()` returns the factory above.
- Base Sepolia market: WETH is the chain's WETH9 predeploy `0x4200000000000000000000000000000000000006`, and USDC is Aave's test token `0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f`. The test token's `owner()` is Aave's faucet `0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc`, whose `getTokenConfig(USDC)` read 3,600 seconds and 1,000,000 tokens: one mint an hour per address, up to a million test USDC.
- At the pinned Base Sepolia block every fee tier for this pair already had a pool, at prices others had left: 0.01% at 0.98 of the oracle price, 0.05% at the bottom of its range, 0.30% at 0.60 and 1% at 1.34.

## Scripts

Neither script sends anything unless run with `--broadcast`. Run it without first: Foundry simulates against the live chain and prints what it would send.

### DeployUnwind

Deploys `LeveeUnwind` with the constructor arguments for the chain the RPC serves, which must be Base, Arbitrum One or Base Sepolia. It signs with `DEPLOYER_PRIVATE_KEY` if that is set, and otherwise with Foundry's wallet flags.

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

Funds: ETH for about 1.8M gas. Nothing else.

### SeedTestnetPool

Moves the Base Sepolia Uniswap v3 pool for Aave's WETH and test USDC to Aave's oracle price and adds a position around it, so `unwind` can run live. Every tier for the pair already exists, so the script swaps the pool to the oracle price with a small `PoolPriceMover` contract it deploys. SwapRouter02 cannot do this, because it refuses a swap across an empty range. The script then mints a position with the official NonfungiblePositionManager, owned by the deployer. It reads the key from `TEST_EOA_PRIVATE_KEY` and does not print it.

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

- Base Sepolia ETH for `SEED_WETH_WEI` plus gas. A first run on the fork used 1.46M execution gas over about a dozen transactions, so budget 2M. The script wraps any WETH it lacks from the deployer's ETH and keeps the gas reserve.
- Test USDC comes from Aave's faucet. The script asks it for any shortfall plus 10,000, which pays for moving the price up. The faucet allows one mint an hour per address, so a second run inside the hour needs the USDC already in the wallet. Otherwise it stops with `faucet timelock: wait an hour or lower SEED_USDC_UNITS`.
- At the pinned block the 0.30% pool held 0.42 WETH and 497 test USDC of other people's liquidity. Moving its price up to the oracle buys at most that WETH, for test USDC.

The defaults put 0.2 WETH and about 450 test USDC in a 6% range. By that position's virtual reserves, not measured, a 50 USDC unwind would cost about 0.65% with the fee, so keep live unwinds to tens of USDC under a 100 bps bound, or seed more. The oracle tracks the real ETH price and nobody arbitrages this pool, so run the script again shortly before each live unwind. A rerun moves the price through the existing position and adds to it. `UnwindBaseSepoliaTest` runs the same script before every test, from an address that holds only ETH.
