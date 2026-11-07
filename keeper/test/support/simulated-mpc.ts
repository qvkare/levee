/**
 * SIMULATED MPC. A local key stands in for the NEAR MPC network so tests can exercise
 * signature assembly without one. Nothing signed here proves anything about the real
 * network, and the key is generated per process and never stored.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import {
  type Address,
  type Hex,
  encodeFunctionData,
  hexToBytes,
  keccak256,
  parseAbi,
  serializeTransaction,
} from 'viem';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import type { RescueResult } from '../../src/signature.js';

const REPAY_ABI = parseAbi([
  'function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) returns (uint256)',
]);

export interface SimulatedTxFields {
  chainId: number;
  nonce: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gas?: bigint;
  to: Address;
  data: Hex;
  value?: bigint;
}

export function repayCalldata(
  usdc: Address,
  amount: bigint,
  rateMode: bigint,
  onBehalfOf: Address,
): Hex {
  return encodeFunctionData({
    abi: REPAY_ABI,
    functionName: 'repay',
    args: [usdc, amount, rateMode, onBehalfOf],
  });
}

/** The unsigned bytes the contract builds in spec section 4. */
export function unsignedTransaction(fields: SimulatedTxFields): Hex {
  return serializeTransaction({
    type: 'eip1559',
    chainId: fields.chainId,
    nonce: fields.nonce,
    maxFeePerGas: fields.maxFeePerGas,
    maxPriorityFeePerGas: fields.maxPriorityFeePerGas,
    gas: fields.gas ?? 300_000n,
    to: fields.to,
    value: fields.value ?? 0n,
    data: fields.data,
    accessList: [],
  });
}

export interface SimulatedMpc {
  address: Address;
  sign(unsignedTx: Hex, id: number, kind?: string): RescueResult;
}

/** Signs the way the MPC network does: over the given hash, with no further hashing. */
export function createSimulatedMpc(privateKey: Hex = generatePrivateKey()): SimulatedMpc {
  return {
    address: privateKeyToAddress(privateKey),
    sign(unsignedTx, id, kind = 'rescue') {
      const hash = keccak256(unsignedTx);
      const signature = secp256k1.Signature.fromBytes(
        secp256k1.sign(hexToBytes(hash), hexToBytes(privateKey), {
          prehash: false,
          format: 'recovered',
        }),
        'recovered',
      );
      if (signature.recovery === undefined) throw new Error('no recovery id');
      const r = signature.r.toString(16).padStart(64, '0');
      const s = signature.s.toString(16).padStart(64, '0');
      return {
        kind,
        id,
        unsigned_tx: unsignedTx.slice(2),
        tx_hash: hash.slice(2),
        big_r: { affine_point: `${signature.recovery === 0 ? '02' : '03'}${r}`.toUpperCase() },
        s: { scalar: s.toUpperCase() },
        recovery_id: signature.recovery,
      };
    },
  };
}
