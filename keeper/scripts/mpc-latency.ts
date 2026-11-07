/**
 * Measures real MPC signing through the Levee contract. It asks for repay signatures and never
 * broadcasts them, so nothing moves. Each call uses budget, so run it on a test position.
 *
 *   LEVEE_CONTRACT=... KEEPER_ACCOUNT=... KEEPER_PRIVATE_KEY=... \
 *     pnpm --silent --filter keeper exec tsx scripts/mpc-latency.ts --id 1 --runs 10 --out ../evidence/mpc-latency-testnet.json
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { deriveRescuerAddress } from '../src/derive.ts';
import { createNearRescuer, MPC_CONTRACTS, NEAR_RPC_URLS } from '../src/near.ts';
import { assembleSignedTransaction } from '../src/signature.ts';

const { values } = parseArgs({
  options: {
    id: { type: 'string', default: '1' },
    runs: { type: 'string', default: '10' },
    amount: { type: 'string', default: '1000000' },
    out: { type: 'string' },
  },
});

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const network = 'testnet';
const contract = env('LEVEE_CONTRACT');
const id = Number(values.id);
const runs = Number(values.runs);
const rpcUrl = process.env.NEAR_RPC_URL ?? NEAR_RPC_URLS[network][0];

async function rootKey(): Promise<string> {
  const body = {
    jsonrpc: '2.0',
    id: 'levee',
    method: 'query',
    params: {
      request_type: 'call_function',
      finality: 'final',
      account_id: MPC_CONTRACTS[network],
      method_name: 'public_key',
      args_base64: Buffer.from(JSON.stringify({ domain_id: 0 })).toString('base64'),
    },
  };
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await response.json()) as { result: { result: number[] } };
  return JSON.parse(Buffer.from(json.result.result).toString()) as string;
}

const percentile = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

async function main(): Promise<void> {
  const rescuer = createNearRescuer({
    rpcUrl,
    contract,
    accountId: env('KEEPER_ACCOUNT'),
    privateKey: env('KEEPER_PRIVATE_KEY'),
  });
  const expected = deriveRescuerAddress(await rootKey(), contract, id);
  console.log(`rescuer ${expected}`);

  const samples: Array<Record<string, unknown>> = [];
  for (let run = 0; run < runs; run += 1) {
    const started = Date.now();
    try {
      const outcome = await rescuer.rescue({
        id,
        amount: BigInt(values.amount as string),
        fees: { nonce: run, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000n },
      });
      const assembled = await assembleSignedTransaction(outcome.result);
      if (assembled.signer.toLowerCase() !== expected.toLowerCase()) {
        throw new Error(`recovered ${assembled.signer}, expected ${expected}`);
      }
      const elapsed = Date.now() - started;
      samples.push({
        run,
        outcome: 'signed',
        elapsed_ms: elapsed,
        included_ms: outcome.includedAtMs - started,
        near_tx: outcome.nearTx,
        evm_tx_hash: assembled.hash,
        recovered_signer: assembled.signer,
      });
      console.log(`${run}: ${elapsed} ms, signer ${assembled.signer}`);
    } catch (error) {
      samples.push({ run, outcome: 'failed', elapsed_ms: Date.now() - started, failure_reason: String(error) });
      console.log(`${run}: failed, ${error}`);
    }
  }

  const ok = samples.filter((s) => s.outcome === 'signed').map((s) => s.elapsed_ms as number).sort((a, b) => a - b);
  const summary = {
    network,
    contract,
    mpc: MPC_CONTRACTS[network],
    position_id: id,
    rescuer: expected,
    measured_at: new Date().toISOString(),
    note: 'Signature only. Nothing was broadcast. Time from the keeper sending rescue to holding a verified signature.',
    runs,
    signed: ok.length,
    failed: runs - ok.length,
    p50_ms: ok.length ? percentile(ok, 50) : null,
    p95_ms: ok.length ? percentile(ok, 95) : null,
    max_ms: ok.length ? ok[ok.length - 1] : null,
    samples,
  };
  console.log(JSON.stringify({ signed: summary.signed, failed: summary.failed, p50: summary.p50_ms, p95: summary.p95_ms, max: summary.max_ms }));
  if (values.out) writeFileSync(values.out, `${JSON.stringify(summary, null, 2)}\n`);
}

await main();
