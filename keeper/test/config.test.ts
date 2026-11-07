import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHAINS } from '../src/chains.js';
import {
  REPO_ROOT,
  evidenceDirFrom,
  loadConfig,
  loadCredentials,
  parseNetwork,
  parsePositionsFile,
} from '../src/config.js';
import { parseWad } from '../src/decision.js';
import { DEFAULT_EVIDENCE_DIR } from '../src/evidence.js';

const base = CHAINS[8453] as NonNullable<(typeof CHAINS)[8453]>;
const baseSepolia = CHAINS[84532] as NonNullable<(typeof CHAINS)[84532]>;
const arbitrumSepolia = CHAINS[421614] as NonNullable<(typeof CHAINS)[421614]>;

const positions = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    positions: [{ id: 1, trigger: '1.25', target: '1.6' }],
    fee_ceilings: { '84532': { max_fee_per_gas: '100', max_priority_fee_per_gas: '10' } },
    ...over,
  });

describe('parseNetwork', () => {
  it('defaults to testnet', () => {
    expect(parseNetwork(undefined)).toBe('testnet');
    expect(parseNetwork('')).toBe('testnet');
  });

  it('accepts mainnet', () => {
    expect(parseNetwork('mainnet')).toBe('mainnet');
  });

  it('rejects anything else', () => {
    expect(() => parseNetwork('devnet')).toThrow(/must be mainnet or testnet/);
  });
});

describe('parsePositionsFile', () => {
  it('reads the trigger and target as wad', () => {
    const { positions: [position] } = parsePositionsFile(positions());
    expect(position).toEqual({
      id: 1,
      trigger: '1.25',
      target: '1.6',
      triggerWad: parseWad('1.25'),
      targetWad: parseWad('1.6'),
    });
  });

  it('accepts the example shipped with the package', async () => {
    const example = await readFile(join(REPO_ROOT, 'keeper/positions.example.json'), 'utf8');
    expect(parsePositionsFile(example).positions.length).toBeGreaterThan(0);
  });

  it.each([
    ['a trigger at 1, where Aave already liquidates', '1', '1.6', /must be above 1/],
    ['a trigger below 1', '0.9', '1.6', /must be above 1/],
    ['a target equal to the trigger', '1.25', '1.25', /must be above trigger/],
    ['a target below the trigger', '1.5', '1.25', /must be above trigger/],
    ['a value that is not a decimal', '1,25', '1.6', /not a decimal/],
  ])('rejects %s', (_name, trigger, target, message) => {
    const text = positions({ positions: [{ id: 1, trigger, target }] });
    expect(() => parsePositionsFile(text)).toThrow(message);
  });

  it('rejects a position listed twice, which would run two loops on one rescuer', () => {
    const entry = { id: 1, trigger: '1.25', target: '1.6' };
    expect(() => parsePositionsFile(positions({ positions: [entry, entry] }))).toThrow(/twice/);
  });

  it('rejects an empty position list', () => {
    expect(() => parsePositionsFile(positions({ positions: [] }))).toThrow();
  });

  it('rejects a fee ceiling that is not a whole number of wei', () => {
    const fee_ceilings = { '84532': { max_fee_per_gas: '1.5', max_priority_fee_per_gas: '1' } };
    expect(() => parsePositionsFile(positions({ fee_ceilings }))).toThrow();
  });
});

describe('loadConfig', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'levee-config-'));
    file = join(dir, 'positions.json');
    await writeFile(file, positions());
  });

  afterEach(() => rm(dir, { recursive: true, force: true }));

  const env = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    LEVEE_CONTRACT: 'levee.testnet',
    KEEPER_CONFIG: file,
    ...over,
  });

  it('needs no keys', async () => {
    const config = await loadConfig(env());
    expect(config.contract).toBe('levee.testnet');
    expect(config.network).toBe('testnet');
  });

  it('requires the contract', async () => {
    await expect(loadConfig({ KEEPER_CONFIG: file })).rejects.toThrow(/LEVEE_CONTRACT/);
  });

  it('points at the MPC contract and RPC of the network', async () => {
    const testnet = await loadConfig(env());
    expect(testnet.mpc).toBe('v1.signer-prod.testnet');
    expect(testnet.nearRpcUrl).toContain('test');

    const mainnet = await loadConfig(env({ NEAR_NETWORK: 'mainnet' }));
    expect(mainnet.mpc).toBe('v1.signer');
    expect(mainnet.nearRpcUrl).not.toContain('test');
  });

  it('prefers a configured NEAR RPC', async () => {
    const config = await loadConfig(env({ NEAR_RPC_URL: 'https://near.example' }));
    expect(config.nearRpcUrl).toBe('https://near.example');
  });

  it('reads the comma separated RPC list of the chain family', async () => {
    const config = await loadConfig(
      env({ BASE_RPC_URLS: 'https://a.example, https://b.example ,', ARBITRUM_RPC_URLS: 'https://c.example' }),
    );
    expect(config.rpcUrls(base)).toEqual(['https://a.example', 'https://b.example']);
    expect(config.rpcUrls(baseSepolia)).toEqual(['https://a.example', 'https://b.example']);
    expect(config.rpcUrls(arbitrumSepolia)).toEqual(['https://c.example']);
  });

  it('collapses a repeated URL, so it cannot pose as a second endpoint', async () => {
    const config = await loadConfig(env({ BASE_RPC_URLS: 'https://a.example,https://a.example' }));
    expect(config.rpcUrls(base)).toEqual(['https://a.example']);
  });

  it('gives the ceilings for a chain', async () => {
    const config = await loadConfig(env());
    expect(config.feeCeilings(baseSepolia)).toEqual({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n });
  });

  it('names the chain when its ceilings are missing', async () => {
    const config = await loadConfig(env());
    expect(() => config.feeCeilings(base)).toThrow(/no fee_ceilings for chain 8453/);
  });

  it('reports a missing positions file', async () => {
    await expect(loadConfig(env({ KEEPER_CONFIG: join(dir, 'gone.json') }))).rejects.toThrow(/ENOENT/);
  });
});

describe('loadCredentials', () => {
  it('needs both the account and the key', () => {
    expect(() => loadCredentials({})).toThrow(/KEEPER_ACCOUNT and KEEPER_PRIVATE_KEY/);
    expect(() => loadCredentials({ KEEPER_ACCOUNT: 'k.testnet' })).toThrow();
    expect(() => loadCredentials({ KEEPER_PRIVATE_KEY: 'ed25519:x' })).toThrow();
  });

  it('returns them when set', () => {
    const credentials = loadCredentials({ KEEPER_ACCOUNT: 'k.testnet', KEEPER_PRIVATE_KEY: 'ed25519:x' });
    expect(credentials).toEqual({ accountId: 'k.testnet', privateKey: 'ed25519:x' });
  });
});

describe('evidenceDirFrom', () => {
  it('defaults to the repo evidence directory', () => {
    expect(evidenceDirFrom({})).toBe(DEFAULT_EVIDENCE_DIR);
  });

  it('can be overridden', () => {
    expect(evidenceDirFrom({ EVIDENCE_DIR: '/tmp/x' })).toBe('/tmp/x');
  });
});
