/**
 * The `LeveeUnwind` helper's surface, spec section 9: the call the contract signs, the
 * event it emits, its per-borrower config view and the revert it gives when the
 * health factor is above the borrower's trigger. Everything that depends on the
 * helper's source is in this file.
 */
import {
  type Address,
  type Hex,
  decodeEventLog,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  parseAbiItem,
  toBytes,
  toFunctionSelector,
} from 'viem';

/** `unwind(address,address,uint256,uint24)`. Fixed by spec section 9. */
export const UNWIND_SELECTOR = '0xd0cda3c2';

const UNWIND_ABI = parseAbi([
  'function unwind(address borrower, address collateral, uint256 amount, uint24 poolFee) returns (uint256 repaid, uint256 sold)',
]);

/** The topic does not depend on which parameters are indexed. */
export const UNWOUND_TOPIC: Hex = keccak256(
  toBytes('Unwound(address,address,address,uint256,uint256)'),
);

/**
 * TODO(merge): name and ABI of the helper's per-borrower config view, from
 * `evm/src/LeveeUnwind.sol`. The keeper needs the authorized rescuer, the slippage
 * limit and the trigger and target health factors (wad, as Aave reports them). If
 * the view returns a struct or another order, change `helperConfigFrom` with it.
 */
export const HELPER_CONFIG_VIEW = {
  functionName: 'configOf',
  abi: parseAbi([
    'function configOf(address borrower) view returns (address rescuer, uint16 maxSlippageBps, uint256 triggerHf, uint256 targetHf)',
  ]),
} as const;

/**
 * TODO(merge): the custom error `unwind` reverts with when the borrower's health factor
 * is at or above their trigger. The name comes from `evm/src/LeveeUnwind.sol`.
 */
export const ABOVE_TRIGGER_ERROR = 'AboveTrigger()';

export const ABOVE_TRIGGER_SELECTOR: Hex = toFunctionSelector(ABOVE_TRIGGER_ERROR);

/** What the borrower set with `authorize`. */
export interface HelperConfig {
  /** The only address that may call `unwind` for this borrower. Zero once revoked. */
  rescuer: Address;
  maxSlippageBps: bigint;
  /** Wad. */
  triggerHf: bigint;
  /** Wad. */
  targetHf: bigint;
}

type HelperConfigResult = readonly [Address, number, bigint, bigint];

/** Adapts the view's return value. Changes with `HELPER_CONFIG_VIEW`. */
export function helperConfigFrom(result: HelperConfigResult): HelperConfig {
  const [rescuer, maxSlippageBps, triggerHf, targetHf] = result;
  return { rescuer: getAddress(rescuer), maxSlippageBps: BigInt(maxSlippageBps), triggerHf, targetHf };
}

export interface DecodedUnwind {
  borrower: Address;
  collateral: Address;
  amount: bigint;
  poolFee: bigint;
}

export function unwindCalldata(call: DecodedUnwind): Hex {
  return encodeFunctionData({
    abi: UNWIND_ABI,
    functionName: 'unwind',
    args: [call.borrower, call.collateral, call.amount, Number(call.poolFee)],
  });
}

/** Decodes `unwind` calldata, or returns null for anything else. */
export function decodeUnwind(data: Hex): DecodedUnwind | null {
  if (!data.toLowerCase().startsWith(UNWIND_SELECTOR)) return null;
  try {
    const { args } = decodeFunctionData({ abi: UNWIND_ABI, data });
    const [borrower, collateral, amount, poolFee] = args;
    return {
      borrower: getAddress(borrower),
      collateral: getAddress(collateral),
      amount,
      poolFee: BigInt(poolFee),
    };
  } catch {
    return null;
  }
}

export interface EvmLog {
  address: Address;
  topics: Hex[];
  data: Hex;
}

export interface Unwound {
  borrower: Address;
  rescuer: Address;
  collateral: Address;
  /** USDC base units repaid. */
  repaid: bigint;
  /** Collateral base units sold. */
  sold: bigint;
}

/**
 * TODO(merge): spec section 9 names the fields but not which are indexed. The keeper
 * reads any prefix of the three addresses as indexed, chosen by the topic count, so
 * the usual declarations all decode. Narrow this to the helper's own declaration.
 */
const UNWOUND_BY_INDEXED_COUNT = [
  parseAbiItem(
    'event Unwound(address borrower, address rescuer, address collateral, uint256 repaid, uint256 sold)',
  ),
  parseAbiItem(
    'event Unwound(address indexed borrower, address rescuer, address collateral, uint256 repaid, uint256 sold)',
  ),
  parseAbiItem(
    'event Unwound(address indexed borrower, address indexed rescuer, address collateral, uint256 repaid, uint256 sold)',
  ),
  parseAbiItem(
    'event Unwound(address indexed borrower, address indexed rescuer, address indexed collateral, uint256 repaid, uint256 sold)',
  ),
] as const;

/** Decodes one `Unwound` log, or returns null if this log is not one. */
export function decodeUnwound(log: EvmLog): Unwound | null {
  if (log.topics[0]?.toLowerCase() !== UNWOUND_TOPIC) return null;
  const event = UNWOUND_BY_INDEXED_COUNT[log.topics.length - 1];
  if (!event) return null;
  try {
    const { args } = decodeEventLog({
      abi: [event],
      topics: log.topics as [Hex, ...Hex[]],
      data: log.data,
      strict: true,
    });
    return {
      borrower: getAddress(args.borrower),
      rescuer: getAddress(args.rescuer),
      collateral: getAddress(args.collateral),
      repaid: args.repaid,
      sold: args.sold,
    };
  } catch {
    return null;
  }
}

/** Every `Unwound` the helper emitted in these logs. Other contracts cannot fake one. */
export function unwoundEvents(logs: readonly EvmLog[], helper: Address): Unwound[] {
  return logs
    .filter((log) => log.address.toLowerCase() === helper.toLowerCase())
    .flatMap((log) => {
      const decoded = decodeUnwound(log);
      return decoded ? [decoded] : [];
    });
}

/** True when the revert data is the helper's above-trigger error. */
export const isAboveTrigger = (revertData: string | null | undefined): boolean =>
  !!revertData && revertData.slice(0, 10).toLowerCase() === ABOVE_TRIGGER_SELECTOR;

/** What the keeper was configured with, in the units the helper uses. */
export interface ExpectedHelperConfig {
  triggerWad: bigint;
  targetWad: bigint;
  maxSlippageBps?: bigint;
}

/**
 * Why the borrower's setting at the helper does not match the keeper's, or null if it
 * does. The helper's values are the ones `unwind` enforces, so the keeper acts only
 * when its own agree with them, and refuses to start when they do not.
 */
export function helperConfigMismatch(
  expected: ExpectedHelperConfig,
  actual: HelperConfig,
  rescuer: Address,
): string | null {
  const problems: string[] = [];
  if (actual.rescuer.toLowerCase() !== rescuer.toLowerCase()) {
    problems.push(`authorized rescuer ${actual.rescuer}, derived rescuer is ${rescuer}`);
  }
  if (actual.triggerHf !== expected.triggerWad) {
    problems.push(`trigger ${actual.triggerHf} at the helper, ${expected.triggerWad} configured`);
  }
  if (actual.targetHf !== expected.targetWad) {
    problems.push(`target ${actual.targetHf} at the helper, ${expected.targetWad} configured`);
  }
  if (actual.maxSlippageBps !== expected.maxSlippageBps) {
    problems.push(
      `max_slippage_bps ${actual.maxSlippageBps} at the helper, ${expected.maxSlippageBps} configured`,
    );
  }
  return problems.length === 0 ? null : problems.join('; ');
}

export interface SwapPrice {
  repaid: bigint;
  sold: bigint;
  collateralPriceBase: bigint;
  usdcPriceBase: bigint;
  /** Base currency per whole collateral token, net of the pool fee. Rounded down. */
  effectivePriceBase: bigint;
  /** How far below the oracle the collateral sold, basis points. Negative is above. */
  discountBps: bigint;
}

const USDC_UNIT = 10n ** 6n;
const BPS = 10_000n;

/** What the swap paid per unit of collateral, against Aave's oracle at its block. */
export function swapPrice(
  unwound: Pick<Unwound, 'repaid' | 'sold'>,
  decimals: bigint,
  collateralPriceBase: bigint,
  usdcPriceBase: bigint,
): SwapPrice {
  const effectivePriceBase =
    unwound.sold === 0n
      ? 0n
      : (unwound.repaid * usdcPriceBase * 10n ** decimals) / (USDC_UNIT * unwound.sold);
  const discountBps =
    collateralPriceBase === 0n
      ? 0n
      : ((collateralPriceBase - effectivePriceBase) * BPS) / collateralPriceBase;
  return { ...unwound, collateralPriceBase, usdcPriceBase, effectivePriceBase, discountBps };
}
