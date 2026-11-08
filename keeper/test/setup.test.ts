import { describe, expect, it } from 'vitest';
import type { KeeperConfig } from '../src/config.js';
import { parseWad } from '../src/decision.js';
import { deriveRescuerAddress } from '../src/derive.js';
import type { NearViews } from '../src/near.js';
import { assertIsKeeper, rescueContext, wirePosition } from '../src/setup.js';
import { describePosition } from '../src/status.js';
import {
  borrower,
  fakeEvm,
  fakeNear,
  healthySample,
  nowMs,
  openPosition,
  positionTarget,
  sickSample,
} from './support/fakes.js';
import { createSimulatedMpc } from './support/simulated-mpc.js';

// Recorded from v1.signer-prod.testnet 3.18.0. See derive.test.ts.
const root =
  'secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8fGBiJB8TBtFMP5WWXz6B89Ac1fbpzPwAvoyQebemHFwx3';
const levee1 =
  'secp256k1:5ikbbmFA1mE31RonV1gFapgNsu9zh5gwomzTQc4LjxXQQENXwu45cqBMgkaNGikEtYWVKrjH6mNzQbwSQu2B74mY';

const config = (over: Partial<KeeperConfig> = {}): KeeperConfig => ({
  network: 'testnet',
  contract: 'levee.testnet',
  mpc: 'v1.signer-prod.testnet',
  nearRpcUrl: 'https://near.invalid',
  positions: [positionTarget],
  evidenceDir: '/tmp/unused',
  rpcUrls: () => ['https://a.invalid', 'https://b.invalid'],
  feeCeilings: () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }),
  ...over,
});

const views = (over: Partial<NearViews> = {}): NearViews => ({
  getPosition: async () => openPosition({ chain_id: 84532 }),
  rootPublicKey: async () => root,
  derivedPublicKey: async () => levee1,
  getChain: async () => null,
  ...over,
});

const wire = (cfg = config(), nearViews = views()) =>
  wirePosition(cfg, nearViews, positionTarget, (url) => fakeEvm(url));

describe('wirePosition', () => {
  it('joins the contract position to a checked rescuer', async () => {
    const wiring = await wire();

    expect(wiring.chain.name).toBe('base-sepolia');
    expect(wiring.borrower).toBe(borrower);
    expect(wiring.rescuer).toBe(deriveRescuerAddress(root, 'levee.testnet', 1));
    expect(wiring.clients.map((client) => client.url)).toEqual([
      'https://a.invalid',
      'https://b.invalid',
    ]);
  });

  it('refuses to start when local derivation disagrees with the MPC contract', async () => {
    const lying = views({ derivedPublicKey: async () => root });
    await expect(wire(config(), lying)).rejects.toThrow(/differs from v1.signer-prod.testnet/);
  });

  it('refuses a single endpoint, since quorum could never pass', async () => {
    const one = config({ rpcUrls: () => ['https://a.invalid'] });
    await expect(wire(one)).rejects.toThrow(/quorum needs 2/);
  });

  it('refuses a position on a chain of the other network', async () => {
    const nearViews = views({ getPosition: async () => openPosition({ chain_id: 8453 }) });
    await expect(wire(config(), nearViews)).rejects.toThrow(/not a testnet chain/);
  });

  it('refuses a chain outside the spec', async () => {
    const nearViews = views({ getPosition: async () => openPosition({ chain_id: 1 }) });
    await expect(wire(config(), nearViews)).rejects.toThrow(/not in spec section 3/);
  });
});

describe('assertIsKeeper', () => {
  it('accepts the position keeper', async () => {
    expect(() => assertIsKeeper({ position: openPosition() } as never, 'keeper.testnet')).not.toThrow();
  });

  it('stops a key that rescue rule 1 would reject on every attempt', () => {
    const wiring = { position: openPosition(), target: positionTarget } as never;
    expect(() => assertIsKeeper(wiring, 'stranger.testnet')).toThrow(/has keeper keeper.testnet/);
  });
});

describe('rescueContext', () => {
  it('carries the configured ceilings and evidence directory', async () => {
    const wiring = await wire();
    const ctx = rescueContext({
      config: config(),
      wiring,
      views: views(),
      near: fakeNear(createSimulatedMpc()),
      log: () => {},
    });

    expect(ctx.network).toBe('testnet');
    expect(ctx.ceilings).toEqual({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n });
    expect(ctx.evidenceDir).toBe('/tmp/unused');
    expect(ctx.nearContract).toBe('levee.testnet');
  });
});

describe('describePosition', () => {
  const wiringWith = async (make: (url: string) => ReturnType<typeof fakeEvm>) => {
    const wiring = await wirePosition(config(), views(), positionTarget, make);
    return { ...wiring, chain: { ...wiring.chain, chainId: 8453 } };
  };
  const now = () => nowMs;

  it('shows a healthy position with no action', async () => {
    const wiring = await wiringWith((url) => fakeEvm(url, healthySample(url)));

    const text = await describePosition(wiring, now);

    expect(text).toContain('Position 1 on base-sepolia');
    expect(text).toContain('quorum ok');
    expect(text).toContain('health factor 1.9');
    expect(text).toContain('no action: healthy');
  });

  it('shows what it would repay without sending anything', async () => {
    const clients = new Map<string, ReturnType<typeof fakeEvm>>();
    const wiring = await wiringWith((url) => {
      const client = fakeEvm(url, sickSample(url));
      clients.set(url, client);
      return client;
    });

    const text = await describePosition(wiring, now);

    expect(text).toContain('would repay 4000.000002 USDC, limited by target');
    for (const client of clients.values()) expect(client.broadcasts).toEqual([]);
  });

  it('shows a quorum refusal', async () => {
    const wiring = await wiringWith((url) =>
      fakeEvm(url, sickSample(url, { healthFactor: url.includes('a.') ? parseWad('1.1') : parseWad('1.2') })),
    );

    expect(await describePosition(wiring, now)).toContain('quorum refused: disagreement');
  });
});
