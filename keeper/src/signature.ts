/**
 * Turns the contract's rescue result into a signed EIP-1559 transaction, and refuses
 * to hand it over unless it does exactly what was asked, from exactly the right key.
 */
import {
  type Address,
  type Hex,
  type TransactionSerializableEIP1559,
  decodeFunctionData,
  getAddress,
  hexToBigInt,
  isHex,
  keccak256,
  parseAbi,
  parseTransaction,
  recoverTransactionAddress,
  serializeTransaction,
} from 'viem';
import { z } from 'zod';

/** secp256k1 group order. EIP-2 rejects signatures with `s` above half of it. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const REPAY_ABI = parseAbi([
  'function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) returns (uint256)',
]);

export const REPAY_SELECTOR = '0x573ade81';
export const VARIABLE_RATE_MODE = 2n;

const hexString = z.string().regex(/^(0x)?[0-9a-fA-F]+$/, 'expected hex');

/**
 * What the contract's callback returns. The MPC contract wraps `big_r` and `s` in
 * `{ affine_point }` and `{ scalar }`, so both that and the flat form are accepted.
 */
export const rescueResultSchema = z.object({
  kind: z.string(),
  id: z.number().int().nonnegative(),
  unsigned_tx: hexString,
  tx_hash: hexString,
  big_r: z.union([hexString, z.object({ affine_point: hexString })]),
  s: z.union([hexString, z.object({ scalar: hexString })]),
  recovery_id: z.number().int().nonnegative(),
});

export type RescueResult = z.infer<typeof rescueResultSchema>;

export interface EvmSignature {
  r: Hex;
  s: Hex;
  yParity: 0 | 1;
}

/** A hard stop: the transaction must not reach an RPC. */
export class SignatureRefused extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'SignatureRefused';
  }
}

const with0x = (value: string): Hex =>
  (value.startsWith('0x') ? value : `0x${value}`).toLowerCase() as Hex;

/** Spec section 3: `r` is bytes 1..33 of the compressed `big_r`. */
export function parseSignature(result: Pick<RescueResult, 'big_r' | 's' | 'recovery_id'>): EvmSignature {
  const bigR = with0x(typeof result.big_r === 'string' ? result.big_r : result.big_r.affine_point);
  const s = with0x(typeof result.s === 'string' ? result.s : result.s.scalar);

  if (bigR.length !== 2 + 66 || !/^0x0[23]/.test(bigR)) {
    throw new SignatureRefused('malformed_signature', `big_r is not a compressed point: ${bigR}`);
  }
  if (s.length !== 2 + 64) {
    throw new SignatureRefused('malformed_signature', `s is not 32 bytes: ${s}`);
  }
  if (hexToBigInt(s) * 2n > SECP256K1_N) {
    throw new SignatureRefused('malformed_signature', 's is not low-s normalised');
  }
  if (result.recovery_id !== 0 && result.recovery_id !== 1) {
    throw new SignatureRefused(
      'malformed_signature',
      `recovery_id ${result.recovery_id} has no y parity`,
    );
  }
  return { r: `0x${bigR.slice(4)}`, s, yParity: result.recovery_id };
}

export interface AssembledTransaction {
  /** Signed bytes, ready for `eth_sendRawTransaction`. */
  serialized: Hex;
  /** The EVM transaction hash. */
  hash: Hex;
  /** The fields that were signed. */
  tx: TransactionSerializableEIP1559;
  /** The address the signature recovers to. */
  signer: Address;
}

function parseUnsigned(unsignedTx: Hex): TransactionSerializableEIP1559 {
  let parsed: ReturnType<typeof parseTransaction>;
  try {
    parsed = parseTransaction(unsignedTx);
  } catch (error) {
    throw new SignatureRefused('malformed_transaction', `unsigned_tx does not parse: ${error}`);
  }
  if (parsed.type !== 'eip1559') {
    throw new SignatureRefused('malformed_transaction', `expected EIP-1559, got ${parsed.type}`);
  }
  if (parsed.r !== undefined || parsed.s !== undefined) {
    throw new SignatureRefused('malformed_transaction', 'unsigned_tx already carries a signature');
  }
  return {
    type: 'eip1559',
    chainId: parsed.chainId,
    nonce: parsed.nonce ?? 0,
    maxFeePerGas: parsed.maxFeePerGas ?? 0n,
    maxPriorityFeePerGas: parsed.maxPriorityFeePerGas ?? 0n,
    gas: parsed.gas ?? 0n,
    to: parsed.to ?? null,
    value: parsed.value ?? 0n,
    data: parsed.data ?? '0x',
    accessList: parsed.accessList ?? [],
  };
}

/**
 * Assembles the signed transaction and recovers its signer. The signature must be
 * over `tx_hash`, and `tx_hash` must be the hash of `unsigned_tx`, or a valid MPC
 * signature could be paired with fields it never covered.
 */
export async function assembleSignedTransaction(
  result: Pick<RescueResult, 'unsigned_tx' | 'tx_hash' | 'big_r' | 's' | 'recovery_id'>,
): Promise<AssembledTransaction> {
  const unsignedTx = with0x(result.unsigned_tx);
  if (!isHex(unsignedTx)) {
    throw new SignatureRefused('malformed_transaction', 'unsigned_tx is not hex');
  }
  const signature = parseSignature(result);
  const tx = parseUnsigned(unsignedTx);

  if (serializeTransaction(tx) !== unsignedTx) {
    throw new SignatureRefused('malformed_transaction', 'unsigned_tx is not canonical');
  }
  if (keccak256(unsignedTx) !== with0x(result.tx_hash)) {
    throw new SignatureRefused('hash_mismatch', 'tx_hash is not the hash of unsigned_tx');
  }

  const serialized = serializeTransaction(tx, signature);
  let signer: Address;
  try {
    signer = await recoverTransactionAddress({ serializedTransaction: serialized });
  } catch (error) {
    throw new SignatureRefused('unrecoverable_signature', `signature does not recover: ${error}`);
  }
  return { serialized, hash: keccak256(serialized), tx, signer };
}

export interface RepayIntent {
  chainId: number;
  nonce: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  pool: Address;
  usdc: Address;
  borrower: Address;
  amount: bigint;
  rescuer: Address;
}

export interface DecodedRepay {
  asset: Address;
  amount: bigint;
  rateMode: bigint;
  onBehalfOf: Address;
}

/** Decodes `Pool.repay` calldata, or returns null for anything else. */
export function decodeRepay(data: Hex): DecodedRepay | null {
  if (!data.toLowerCase().startsWith(REPAY_SELECTOR)) return null;
  try {
    const { args } = decodeFunctionData({ abi: REPAY_ABI, data });
    const [asset, amount, rateMode, onBehalfOf] = args;
    return { asset: getAddress(asset), amount, rateMode, onBehalfOf: getAddress(onBehalfOf) };
  } catch {
    return null;
  }
}

const sameAddress = (a: string | null | undefined, b: string): boolean =>
  a?.toLowerCase() === b.toLowerCase();

/**
 * The broadcast gate. Every field is compared with what was asked for, so a bug or a
 * compromise anywhere upstream ends here rather than on chain.
 */
export function assertMatchesIntent(assembled: AssembledTransaction, intent: RepayIntent): void {
  const { tx, signer } = assembled;
  const refuse = (reason: string, message: string): never => {
    throw new SignatureRefused(reason, message);
  };

  if (!sameAddress(signer, intent.rescuer)) {
    refuse('signer_mismatch', `recovered ${signer}, derived rescuer is ${intent.rescuer}`);
  }
  if (tx.chainId !== intent.chainId) {
    refuse('intent_mismatch', `chain id ${tx.chainId}, expected ${intent.chainId}`);
  }
  if (!sameAddress(tx.to, intent.pool)) {
    refuse('intent_mismatch', `target ${tx.to}, expected the Pool ${intent.pool}`);
  }
  if ((tx.value ?? 0n) !== 0n) {
    refuse('intent_mismatch', `value ${tx.value}, expected 0`);
  }
  if (tx.nonce !== intent.nonce) {
    refuse('intent_mismatch', `nonce ${tx.nonce}, expected ${intent.nonce}`);
  }
  if (tx.maxFeePerGas !== intent.maxFeePerGas) {
    refuse('intent_mismatch', `max fee ${tx.maxFeePerGas}, expected ${intent.maxFeePerGas}`);
  }
  if (tx.maxPriorityFeePerGas !== intent.maxPriorityFeePerGas) {
    refuse(
      'intent_mismatch',
      `priority fee ${tx.maxPriorityFeePerGas}, expected ${intent.maxPriorityFeePerGas}`,
    );
  }

  const repay = decodeRepay(tx.data ?? '0x');
  if (!repay) {
    return refuse('intent_mismatch', `calldata is not repay: ${(tx.data ?? '0x').slice(0, 10)}`);
  }
  if (!sameAddress(repay.asset, intent.usdc)) {
    refuse('intent_mismatch', `asset ${repay.asset}, expected USDC ${intent.usdc}`);
  }
  if (repay.amount !== intent.amount) {
    refuse('intent_mismatch', `amount ${repay.amount}, expected ${intent.amount}`);
  }
  if (repay.rateMode !== VARIABLE_RATE_MODE) {
    refuse('intent_mismatch', `rate mode ${repay.rateMode}, expected ${VARIABLE_RATE_MODE}`);
  }
  if (!sameAddress(repay.onBehalfOf, intent.borrower)) {
    refuse('intent_mismatch', `onBehalfOf ${repay.onBehalfOf}, expected ${intent.borrower}`);
  }
}
