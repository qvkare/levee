#!/usr/bin/env bash
# Generates tx_vectors.json with Foundry's cast. Rust tests assert the contract
# produces these bytes exactly, so nothing here may depend on the contract's code.
#
# Each vector is built twice, by unrelated routes:
#   1. by hand, from `cast calldata`, `cast to-rlp` and `cast keccak`
#   2. by `cast mktx --raw-unsigned`, which goes through alloy
# The script aborts if the two disagree on a single byte.
#
# Usage: contracts/levee/fixtures/generate.sh
# Needs: cast, jq.
set -euo pipefail

cd "$(dirname "$0")"
output="tx_vectors.json"

base_pool="0xA238Dd80C259a72e81d7e4664a9801593F98d1c5"
base_usdc="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
arbitrum_pool="0x794a61358D6845594F94dc1DB02A252b5b4814aD"
arbitrum_usdc="0xaf88d065e77c8cC2239327C5EDb3A432268e5831"
# The LeveeUnwind helper is not deployed yet. Any non-zero address encodes the same way.
base_unwind="0x5555555555555555555555555555555555555555"
arbitrum_unwind="0x6666666666666666666666666666666666666666"
base_weth="0x4200000000000000000000000000000000000006"
arbitrum_weth="0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"
borrower="0x1234567890AbcdEF1234567890aBcdef12345678"
# mktx insists on a sender. It is not part of an unsigned EIP-1559 transaction.
from="0x000000000000000000000000000000000000dEaD"

repay_sig="repay(address,uint256,uint256,address)"
approve_sig="approve(address,uint256)"
transfer_sig="transfer(address,uint256)"
unwind_sig="unwind(address,address,uint256,uint24)"

[ "$(cast sig "$repay_sig")" = "0x573ade81" ] || { echo "repay selector drifted" >&2; exit 1; }
[ "$(cast sig "$approve_sig")" = "0x095ea7b3" ] || { echo "approve selector drifted" >&2; exit 1; }
[ "$(cast sig "$transfer_sig")" = "0xa9059cbb" ] || { echo "transfer selector drifted" >&2; exit 1; }
[ "$(cast sig "$unwind_sig")" = "0xd0cda3c2" ] || { echo "unwind selector drifted" >&2; exit 1; }

# Decimal to the minimal big-endian hex RLP wants. Zero is the empty string.
rlp_uint() {
  if [ "$1" = "0" ]; then
    printf '0x'
    return
  fi
  local digits
  digits="$(cast to-hex "$1")"
  digits="${digits#0x}"
  if [ $((${#digits} % 2)) -eq 1 ]; then
    digits="0$digits"
  fi
  printf '0x%s' "$digits"
}

vectors=()

# add_vector name kind chain_id pool usdc nonce max_fee priority gas_limit amount [pool_fee]
# The helper and collateral come from $unwind and $collateral, set per chain below.
add_vector() {
  local name="$1" kind="$2" chain_id="$3" pool="$4" usdc="$5"
  local nonce="$6" max_fee="$7" priority="$8" gas_limit="$9" amount="${10}"
  local pool_fee="${11:-500}"
  local to value calldata
  local mktx_call=()

  case "$kind" in
    repay)
      to="$pool"
      value="0"
      calldata="$(cast calldata "$repay_sig" "$usdc" "$amount" 2 "$borrower")"
      mktx_call=("$to" "$repay_sig" "$usdc" "$amount" 2 "$borrower")
      ;;
    approve)
      to="$usdc"
      value="0"
      calldata="$(cast calldata "$approve_sig" "$pool" "$amount")"
      mktx_call=("$to" "$approve_sig" "$pool" "$amount")
      ;;
    transfer)
      to="$usdc"
      value="0"
      calldata="$(cast calldata "$transfer_sig" "$borrower" "$amount")"
      mktx_call=("$to" "$transfer_sig" "$borrower" "$amount")
      ;;
    value)
      to="$borrower"
      value="$amount"
      calldata="0x"
      mktx_call=("$to")
      ;;
    unwind)
      to="$unwind"
      value="0"
      calldata="$(cast calldata "$unwind_sig" "$borrower" "$collateral" "$amount" "$pool_fee")"
      mktx_call=("$to" "$unwind_sig" "$borrower" "$collateral" "$amount" "$pool_fee")
      ;;
    *)
      echo "unknown kind $kind" >&2
      exit 1
      ;;
  esac

  local fields rlp unsigned hash
  fields="$(jq -cn \
    --arg chain_id "$(rlp_uint "$chain_id")" \
    --arg nonce "$(rlp_uint "$nonce")" \
    --arg priority "$(rlp_uint "$priority")" \
    --arg max_fee "$(rlp_uint "$max_fee")" \
    --arg gas_limit "$(rlp_uint "$gas_limit")" \
    --arg to "$to" \
    --arg value "$(rlp_uint "$value")" \
    --arg data "$calldata" \
    '[$chain_id, $nonce, $priority, $max_fee, $gas_limit, $to, $value, $data, []]')"
  rlp="$(cast to-rlp "$fields")"
  unsigned="0x02${rlp#0x}"
  hash="$(cast keccak "$unsigned")"

  local from_mktx
  from_mktx="$(cast mktx --raw-unsigned --from "$from" \
    --chain "$chain_id" --nonce "$nonce" --gas-limit "$gas_limit" \
    --gas-price "$max_fee" --priority-gas-price "$priority" --value "$value" \
    "${mktx_call[@]}")"
  if [ "$unsigned" != "$from_mktx" ]; then
    echo "routes disagree for $name" >&2
    echo "  to-rlp: $unsigned" >&2
    echo "  mktx:   $from_mktx" >&2
    exit 1
  fi

  vectors+=("$(jq -cn \
    --arg name "$name" --arg kind "$kind" --argjson chain_id "$chain_id" \
    --arg pool "$pool" --arg usdc "$usdc" --arg borrower "$borrower" \
    --arg unwind "$unwind" --arg collateral "$collateral" --argjson pool_fee "$pool_fee" \
    --argjson nonce "$nonce" --arg max_fee_per_gas "$max_fee" \
    --arg max_priority_fee_per_gas "$priority" --argjson gas_limit "$gas_limit" \
    --arg amount "$amount" --arg to "$to" --arg value "$value" \
    --arg calldata "$calldata" --arg unsigned_tx "$unsigned" --arg signing_hash "$hash" \
    '{name: $name, kind: $kind, chain_id: $chain_id, pool: $pool, usdc: $usdc,
      unwind: $unwind, collateral: $collateral, pool_fee: $pool_fee,
      borrower: $borrower, nonce: $nonce, max_fee_per_gas: $max_fee_per_gas,
      max_priority_fee_per_gas: $max_priority_fee_per_gas, gas_limit: $gas_limit,
      amount: $amount, to: $to, value: $value, calldata: $calldata,
      unsigned_tx: $unsigned_tx, signing_hash: $signing_hash}')")
}

two_to_the_100="1267650600228229401496703205376"
u128_max="340282366920938463463374607431768211455"

for chain in base arbitrum; do
  if [ "$chain" = "base" ]; then
    chain_id=8453 pool="$base_pool" usdc="$base_usdc"
    unwind="$base_unwind" collateral="$base_weth"
    gas_repay=350000 gas_approve=70000 gas_transfer=80000
  else
    chain_id=42161 pool="$arbitrum_pool" usdc="$arbitrum_usdc"
    unwind="$arbitrum_unwind" collateral="$arbitrum_weth"
    gas_repay=1500000 gas_approve=500000 gas_transfer=500000
  fi
  # Not measured yet. Spec section 9 expects 350k to 600k.
  gas_unwind=600000

  # A typical call, at everyday fees.
  add_vector "repay-$chain-typical" repay "$chain_id" "$pool" "$usdc" 7 100000000 1000000 "$gas_repay" 2500000
  add_vector "approve-$chain-typical" approve "$chain_id" "$pool" "$usdc" 8 100000000 1000000 "$gas_approve" 75000000
  add_vector "transfer-$chain-typical" transfer "$chain_id" "$pool" "$usdc" 9 100000000 1000000 "$gas_transfer" 1000000
  add_vector "value-$chain-typical" value "$chain_id" "$pool" "$usdc" 10 100000000 1000000 "$gas_transfer" 250000000000000000

  # Smallest encodings: a nonce of zero and single-byte integers.
  add_vector "repay-$chain-smallest" repay "$chain_id" "$pool" "$usdc" 0 1 1 "$gas_repay" 1
  add_vector "approve-$chain-revoke" approve "$chain_id" "$pool" "$usdc" 0 1 1 "$gas_approve" 0
  add_vector "transfer-$chain-smallest" transfer "$chain_id" "$pool" "$usdc" 0 1 1 "$gas_transfer" 1
  add_vector "value-$chain-zero" value "$chain_id" "$pool" "$usdc" 0 1 1 "$gas_transfer" 0

  # Values that sit on RLP boundaries: 0x7f, 0x80, 0xff, 0x0100.
  add_vector "repay-$chain-nonce-127" repay "$chain_id" "$pool" "$usdc" 127 128 127 "$gas_repay" 255
  add_vector "repay-$chain-nonce-128" repay "$chain_id" "$pool" "$usdc" 128 256 255 "$gas_repay" 256

  # The widest values each field can hold.
  add_vector "repay-$chain-widest" repay "$chain_id" "$pool" "$usdc" 18446744073709551614 "$u128_max" "$u128_max" "$gas_repay" "$u128_max"
  add_vector "value-$chain-widest" value "$chain_id" "$pool" "$usdc" 18446744073709551614 "$two_to_the_100" "$two_to_the_100" "$gas_transfer" "$u128_max"

  # Repay from collateral, once in each Uniswap v3 fee tier.
  add_vector "unwind-$chain-typical" unwind "$chain_id" "$pool" "$usdc" 11 100000000 1000000 "$gas_unwind" 2500000 500
  add_vector "unwind-$chain-smallest" unwind "$chain_id" "$pool" "$usdc" 0 1 1 "$gas_unwind" 1 100
  add_vector "unwind-$chain-nonce-128" unwind "$chain_id" "$pool" "$usdc" 128 256 255 "$gas_unwind" 256 3000
  add_vector "unwind-$chain-widest" unwind "$chain_id" "$pool" "$usdc" 18446744073709551614 "$u128_max" "$u128_max" "$gas_unwind" "$u128_max" 10000
done

printf '%s\n' "${vectors[@]}" | jq -s \
  --arg generator "contracts/levee/fixtures/generate.sh" \
  --arg cast_version "$(cast --version | head -1)" \
  '{generator: $generator, cast_version: $cast_version, vectors: .}' > "$output"

echo "wrote $(jq '.vectors | length' "$output") vectors to $output"
