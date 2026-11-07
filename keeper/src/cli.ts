#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  REPO_ROOT,
  evidenceDirFrom,
  loadConfig,
  loadCredentials,
  parseNetwork,
} from './config.js';
import { deriveChildKey, publicKeyToAddress, rescuerPath } from './derive.js';
import { readRunFile, runsDir } from './evidence.js';
import { createLookups } from './lookups.js';
import { watchPosition } from './loop.js';
import {
  MPC_CONTRACTS,
  NEAR_RPC_URLS,
  type NearViews,
  createNearRescuer,
  createNearViews,
} from './near.js';
import { formatReplay, replayRun } from './replay.js';
import { tick } from './rescue.js';
import { assertIsKeeper, rescueContext, wirePosition } from './setup.js';
import { describePosition } from './status.js';
import { formatReport, verifyEvidence } from './verify.js';

const USAGE = `Usage: keeper <command>

  status                          Show each configured position. No keys needed.
  run                             Watch every position until interrupted.
  rescue-once --id <n>            Run one pass for a position, as the loop would.
              [--amount <units>]  Fire now for this many USDC base units, within caps.
  derive-address --id <n>         Derive a position's rescuer and check it live.
              [--contract <id>]   Levee account. Defaults to LEVEE_CONTRACT.
              [--network <net>]   mainnet or testnet. Defaults to NEAR_NETWORK.
              [--predecessor <id> --path <path>]   Derive any path instead of --id.
  verify                          Check evidence/ against public RPCs. No keys needed.
  replay <run>                    Replay a run id or file. No keys or network needed.
`;

const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

const views = (config: Awaited<ReturnType<typeof loadConfig>>): NearViews =>
  createNearViews({ rpcUrl: config.nearRpcUrl, contract: config.contract, mpc: config.mpc });

async function status(env: NodeJS.ProcessEnv): Promise<number> {
  const config = await loadConfig(env);
  const nearViews = views(config);
  for (const target of config.positions) {
    const wiring = await wirePosition(config, nearViews, target);
    console.log(await describePosition(wiring, Date.now));
  }
  return 0;
}

async function rescueContexts(env: NodeJS.ProcessEnv) {
  const config = await loadConfig(env);
  const credentials = loadCredentials(env);
  const nearViews = views(config);
  const near = createNearRescuer({
    rpcUrl: config.nearRpcUrl,
    contract: config.contract,
    ...credentials,
  });
  return Promise.all(
    config.positions.map(async (target) => {
      const wiring = await wirePosition(config, nearViews, target);
      assertIsKeeper(wiring, credentials.accountId);
      return rescueContext({ config, wiring, views: nearViews, near, log });
    }),
  );
}

async function run(env: NodeJS.ProcessEnv): Promise<number> {
  const contexts = await rescueContexts(env);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  log(`watching ${contexts.length} position(s)`);
  await Promise.all(contexts.map((ctx) => watchPosition(ctx, controller.signal)));
  return 0;
}

async function rescueOnce(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { id: { type: 'string' }, amount: { type: 'string' } },
  });
  if (values.id === undefined) throw new Error('rescue-once needs --id');
  const id = Number(values.id);
  const contexts = await rescueContexts(env);
  const ctx = contexts.find((candidate) => candidate.position.id === id);
  if (!ctx) throw new Error(`position ${id} is not in the positions file`);

  const options = values.amount === undefined ? {} : { manualAmount: BigInt(values.amount) };
  const result = await tick(ctx, options);
  if (result.status !== 'recorded') {
    console.log(`no rescue: ${result.reason}`);
    return 0;
  }
  console.log(`${result.run.outcome}: ${result.path}`);
  return result.run.outcome === 'success' ? 0 : 1;
}

async function deriveAddress(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      id: { type: 'string' },
      contract: { type: 'string' },
      network: { type: 'string' },
      predecessor: { type: 'string' },
      path: { type: 'string' },
    },
  });
  const predecessor = values.predecessor ?? values.contract ?? env.LEVEE_CONTRACT;
  if (!predecessor) throw new Error('give --contract, --predecessor or LEVEE_CONTRACT');
  const path = values.path ?? (values.id === undefined ? undefined : rescuerPath(Number(values.id)));
  if (path === undefined) throw new Error('give --id or --path');

  const network = parseNetwork(values.network ?? env.NEAR_NETWORK);
  const mpc = MPC_CONTRACTS[network];
  const rpcUrl = (env.NEAR_NETWORK === network && env.NEAR_RPC_URL) || NEAR_RPC_URLS[network][0];
  if (!rpcUrl) throw new Error(`no NEAR RPC for ${network}`);

  const nearViews = createNearViews({ rpcUrl, contract: predecessor, mpc });
  const [root, live] = await Promise.all([
    nearViews.rootPublicKey(),
    nearViews.derivedPublicKey(path, predecessor),
  ]);
  const derived = deriveChildKey(root, predecessor, path);

  console.log(`mpc         ${mpc} on ${network}`);
  console.log(`predecessor ${predecessor}`);
  console.log(`path        ${path}`);
  console.log(`public key  ${derived}`);
  console.log(`address     ${publicKeyToAddress(derived)}`);
  if (derived !== live) {
    console.log(`MISMATCH: the live contract says ${live}`);
    return 1;
  }
  console.log('matches the live derived_public_key');
  return 0;
}

async function verify(env: NodeJS.ProcessEnv): Promise<number> {
  const report = await verifyEvidence({
    evidenceDir: evidenceDirFrom(env),
    repoRoot: REPO_ROOT,
    lookups: createLookups(env),
  });
  console.log(formatReport(report));
  return report.ok ? 0 : 1;
}

async function replay(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const [target] = args;
  if (!target) throw new Error('replay needs a run id or file');
  const path = existsSync(target)
    ? resolve(target)
    : join(runsDir(evidenceDirFrom(env)), `${target.replace(/\.json$/, '')}.json`);
  const result = await replayRun(await readRunFile(path));
  console.log(formatReplay(result));
  return result.ok ? 0 : 1;
}

function loadDotEnv(): void {
  const path = join(REPO_ROOT, '.env');
  if (existsSync(path)) process.loadEnvFile(path);
}

async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const [command, ...args] = argv;
  switch (command) {
    case 'status':
      return status(env);
    case 'run':
      return run(env);
    case 'rescue-once':
      return rescueOnce(args, env);
    case 'derive-address':
      return deriveAddress(args, env);
    case 'verify':
      return verify(env);
    case 'replay':
      return replay(args, env);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return command === undefined ? 1 : 0;
    default:
      console.error(`unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

loadDotEnv();
main(process.argv.slice(2), process.env).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`keeper: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  },
);
