.PHONY: judge verify replay backtest quote-dry attack-demo test test-contracts test-keeper test-evm test-web

RUN := evidence/runs/2026-11-07T19-23-34Z-base-sepolia-1.json

# No keys and no funds. Run `pnpm install` first.
judge: verify replay backtest quote-dry

# Spec section 6. Reads every recorded run back from public chains.
verify:
	pnpm --silent --filter keeper keeper verify

# Walks one real recorded rescue, offline.
replay:
	pnpm --silent --filter keeper keeper replay ../$(RUN)

# Recomputes the backtest from cached data.
backtest:
	pnpm --silent --filter backtest backtest

# Live NEAR Intents dry quotes for the reserve routes. Nothing moves.
# Confidential when INTENTS_PARTNER_KEY is set, public otherwise.
quote-dry:
	node web/scripts/quote-route.ts

# Each kind of keeper key tries every method it should not reach, in near-sandbox.
attack-demo:
	contracts/build.sh
	cargo test --manifest-path contracts/Cargo.toml -p levee --test sandbox a_function_call_key_limited_to_rescue -- --nocapture

test: test-contracts test-keeper test-evm test-web

test-contracts:
	contracts/build.sh
	cargo test --manifest-path contracts/Cargo.toml --workspace

test-keeper:
	pnpm --silent --filter keeper test

test-evm:
	cd evm && forge test

test-web:
	pnpm --silent --filter web test
