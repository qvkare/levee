#!/usr/bin/env bash
# Builds both contracts to contracts/target/near/. See contracts/README.md.
#
# This has to be cargo-near. It sets `--cfg near`, which selects near-sdk's host
# functions. A plain `cargo build --target wasm32-unknown-unknown` also deploys, but
# near-sdk documents that output as not for on-chain use.
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v cargo-near >/dev/null 2>&1; then
  echo "cargo-near is required: cargo install --locked cargo-near" >&2
  exit 1
fi

cargo near build non-reproducible-wasm --no-abi --locked --manifest-path levee/Cargo.toml
cargo near build non-reproducible-wasm --no-abi --locked --manifest-path mock-signer/Cargo.toml

# cargo-near leaves the old file in place when the bytes come out the same, as they do
# after a test-only edit. The sandbox tests refuse a wasm older than its source, so
# record that these are current.
touch target/near/levee/levee.wasm target/near/mock_signer/mock_signer.wasm
