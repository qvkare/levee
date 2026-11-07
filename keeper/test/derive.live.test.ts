/**
 * Read-only view calls against the real MPC contracts. These prove the local
 * derivation matches `derived_public_key`, so they need network access and no keys.
 */
import { JsonRpcProvider } from 'near-api-js';
import { describe, expect, it } from 'vitest';
import { deriveChildKey, publicKeyToAddress, rescuerPath } from '../src/derive.js';

const targets = [
  { network: 'testnet', mpc: 'v1.signer-prod.testnet', rpc: 'https://test.rpc.fastnear.com' },
  { network: 'mainnet', mpc: 'v1.signer', rpc: 'https://free.rpc.fastnear.com' },
];

const accounts = ['levee.testnet', 'levee.near', 'a-much-longer-account.sub.example.testnet'];
const paths = [rescuerPath(0), rescuerPath(1), rescuerPath(2 ** 40), 'ethereum-1', ''];

describe.each(targets)('$mpc on $network', ({ mpc, rpc }) => {
  const provider = new JsonRpcProvider({ url: rpc });
  const view = <T extends string>(method: string, args: Record<string, unknown>) =>
    provider.callFunction<T>({ contractId: mpc, method, args }) as Promise<T>;

  it('derives the same keys as the live contract', async () => {
    const root = await view('public_key', { domain_id: 0 });
    for (const predecessor of accounts) {
      for (const path of paths) {
        const live = await view('derived_public_key', { path, predecessor, domain_id: 0 });
        expect(deriveChildKey(root, predecessor, path), `${predecessor} ${path}`).toBe(live);
      }
    }
  }, 60_000);

  it('gives each position its own rescuer', async () => {
    const root = await view('public_key', { domain_id: 0 });
    const addresses = [1, 2, 3].map((id) =>
      publicKeyToAddress(deriveChildKey(root, 'levee.testnet', rescuerPath(id))),
    );
    expect(new Set(addresses).size).toBe(3);
  });
});
