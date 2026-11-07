import { secp256k1 } from '@noble/curves/secp256k1.js';
import { base58 } from '@scure/base';
import { bytesToHex, isAddress } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  deriveChildKey,
  deriveRescuerAddress,
  publicKeyToAddress,
  rescuerPath,
} from '../src/derive.js';

// Recorded from v1.signer-prod.testnet 3.18.0, where derive.live.test.ts re-checks it.
const testnetRoot =
  'secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8fGBiJB8TBtFMP5WWXz6B89Ac1fbpzPwAvoyQebemHFwx3';
const levee1 =
  'secp256k1:5ikbbmFA1mE31RonV1gFapgNsu9zh5gwomzTQc4LjxXQQENXwu45cqBMgkaNGikEtYWVKrjH6mNzQbwSQu2B74mY';

describe('rescuerPath', () => {
  it('uses the path the contract signs with', () => {
    expect(rescuerPath(7)).toBe('levee/v1/7');
  });
});

describe('deriveChildKey', () => {
  it('reproduces a key recorded from the live contract', () => {
    expect(deriveChildKey(testnetRoot, 'levee.testnet', 'levee/v1/1')).toBe(levee1);
  });

  it('changes with the account and with the path', () => {
    const other = deriveChildKey(testnetRoot, 'other.testnet', 'levee/v1/1');
    const otherPath = deriveChildKey(testnetRoot, 'levee.testnet', 'levee/v1/2');
    expect(other).not.toBe(levee1);
    expect(otherPath).not.toBe(levee1);
  });
});

describe('publicKeyToAddress', () => {
  it('gives the address a private key would sign from', () => {
    const secret = new Uint8Array(32).fill(7);
    const key = secp256k1.getPublicKey(secret, false).slice(1);
    const address = publicKeyToAddress(`secp256k1:${base58.encode(key)}`);
    expect(address).toBe(privateKeyToAddress(bytesToHex(secret)));
  });

  it('checksums the address it returns', () => {
    const address = deriveRescuerAddress(testnetRoot, 'levee.testnet', 1);
    expect(isAddress(address, { strict: true })).toBe(true);
    expect(address).toBe(publicKeyToAddress(levee1));
  });

  it('rejects a key of another curve', () => {
    expect(() => publicKeyToAddress('ed25519:11111111111111111111111111111111')).toThrow(
      /not a secp256k1 key/,
    );
  });

  it('rejects a key of the wrong length', () => {
    expect(() => publicKeyToAddress(`secp256k1:${base58.encode(new Uint8Array(33))}`)).toThrow(
      /expected 64 bytes/,
    );
  });

  it('rejects coordinates that are not on the curve', () => {
    const offCurve = `secp256k1:${base58.encode(new Uint8Array(64).fill(1))}`;
    expect(() => publicKeyToAddress(offCurve)).toThrow();
  });
});
