/**
 * Chain Signatures address derivation, done locally so a rescuer address can be
 * checked against the MPC contract's `derived_public_key` instead of being trusted.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha3_256 } from '@noble/hashes/sha3.js';
import { base58 } from '@scure/base';
import { type Address, bytesToHex, getAddress, hexToBigInt, keccak256 } from 'viem';

const EPSILON_PREFIX = 'near-mpc-recovery v0.1.0 epsilon derivation:';
const KEY_PREFIX = 'secp256k1:';
const COORDINATES_LENGTH = 64;

const { Point } = secp256k1;

/** Spec section 4: each position has its own rescuer. */
export function rescuerPath(positionId: number): string {
  return `levee/v1/${positionId}`;
}

/** Decodes `secp256k1:<base58 of x || y>`, the form NEAR uses, into the curve point. */
function parsePublicKey(key: string) {
  if (!key.startsWith(KEY_PREFIX)) throw new Error(`not a secp256k1 key: ${key}`);
  const coordinates = base58.decode(key.slice(KEY_PREFIX.length));
  if (coordinates.length !== COORDINATES_LENGTH) {
    throw new Error(`expected ${COORDINATES_LENGTH} bytes of key, got ${coordinates.length}`);
  }
  const uncompressed = new Uint8Array(COORDINATES_LENGTH + 1);
  uncompressed[0] = 0x04;
  uncompressed.set(coordinates, 1);
  return Point.fromBytes(uncompressed);
}

/** The tweak the MPC network adds to its root key for one account and path. */
export function deriveEpsilon(predecessor: string, path: string): bigint {
  const message = new TextEncoder().encode(`${EPSILON_PREFIX}${predecessor},${path}`);
  const digest = hexToBigInt(bytesToHex(sha3_256(message)));
  return Point.Fn.create(digest);
}

/** `root + epsilon * G`, in NEAR's key format. */
export function deriveChildKey(rootKey: string, predecessor: string, path: string): string {
  const tweak = Point.BASE.multiply(deriveEpsilon(predecessor, path));
  const child = parsePublicKey(rootKey).add(tweak);
  return `${KEY_PREFIX}${base58.encode(child.toBytes(false).slice(1))}`;
}

/** The EVM address of a NEAR-format secp256k1 key. */
export function publicKeyToAddress(key: string): Address {
  const coordinates = parsePublicKey(key).toBytes(false).slice(1);
  return getAddress(`0x${keccak256(coordinates).slice(-40)}`);
}

/** The rescuer address for a Levee position. */
export function deriveRescuerAddress(
  rootKey: string,
  leveeContract: string,
  positionId: number,
): Address {
  return publicKeyToAddress(deriveChildKey(rootKey, leveeContract, rescuerPath(positionId)));
}
