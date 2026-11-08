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

/** `unwind(address,address,uint256,uint24,uint256)`. Fixed by spec section 9. */
export const UNWIND_SELECTOR = '0x65afae08';

const UNWIND_ABI = parseAbi([
  'function unwind(address borrower, address collateral, uint256 amount, uint24 poolFee, uint256 maxSold) returns (uint256 repaid, uint256 sold)',
]);

/** The topic does not depend on which parameters are indexed. */
export const UNWOUND_TOPIC: Hex = keccak256(
  toBytes('Unwound(address,address,address,uint256,uint256)'),
);

/** The helper's per-borrower config view, `authorizationOf` in `evm/src/LeveeUnwind.sol`. */
export const HELPER_CONFIG_VIEW = {
  functionName: 'authorizationOf',
  abi: parseAbi([
    'function authorizationOf(address borrower) view returns (address rescuer, uint16 maxSlippageBps, uint64 triggerHf, uint64 targetHf, address collateral, uint24 poolFee)',
  ]),
} as const;

/**
 * The custom error `unwind` reverts with when the borrower's health factor is at or
 * above their trigger: `AboveTrigger(uint256 healthFactor, uint256 triggerHf)`.
 */
export const ABOVE_TRIGGER_ERROR = 'AboveTrigger(uint256,uint256)';

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
  /** The only collateral `unwind` may sell for this borrower. */
  collateral: Address;
  /** The fee tier of the only Uniswap v3 pool `unwind` may sell it in. */
  poolFee: bigint;
}

type HelperConfigResult = readonly [Address, number, bigint, bigint, Address, number];

/** Adapts the view's return value. Changes with `HELPER_CONFIG_VIEW`. */
export function helperConfigFrom(result: HelperConfigResult): HelperConfig {
  const [rescuer, maxSlippageBps, triggerHf, targetHf, collateral, poolFee] = result;
  return {
    rescuer: getAddress(rescuer),
    maxSlippageBps: BigInt(maxSlippageBps),
    triggerHf,
    targetHf,
    collateral: getAddress(collateral),
    poolFee: BigInt(poolFee),
  };
}

export interface DecodedUnwind {
  borrower: Address;
  collateral: Address;
  amount: bigint;
  poolFee: bigint;
  /** The keeper's cap on the collateral sold, in its base units. */
  maxSold: bigint;
}

export function unwindCalldata(call: DecodedUnwind): Hex {
  return encodeFunctionData({
    abi: UNWIND_ABI,
    functionName: 'unwind',
    args: [call.borrower, call.collateral, call.amount, Number(call.poolFee), call.maxSold],
  });
}

/** Decodes `unwind` calldata, or returns null for anything else. */
export function decodeUnwind(data: Hex): DecodedUnwind | null {
  if (!data.toLowerCase().startsWith(UNWIND_SELECTOR)) return null;
  try {
    const { args } = decodeFunctionData({ abi: UNWIND_ABI, data });
    const [borrower, collateral, amount, poolFee, maxSold] = args;
    return {
      borrower: getAddress(borrower),
      collateral: getAddress(collateral),
      amount,
      poolFee: BigInt(poolFee),
      maxSold,
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

/** As declared in `evm/src/LeveeUnwind.sol`: all three addresses are indexed. */
const UNWOUND_EVENT = parseAbiItem(
  'event Unwound(address indexed borrower, address indexed rescuer, address indexed collateral, uint256 repaid, uint256 sold)',
);

/** Decodes one `Unwound` log, or returns null if this log is not one. */
export function decodeUnwound(log: EvmLog): Unwound | null {
  if (log.topics[0]?.toLowerCase() !== UNWOUND_TOPIC) return null;
  if (log.topics.length !== 4) return null;
  try {
    const { args } = decodeEventLog({
      abi: [UNWOUND_EVENT],
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

/**
 * What the keeper was configured with, in the units the helper uses. The trigger, target
 * and slippage come from the positions file, the collateral and pool fee from the
 * contract's `get_position`, which is what `rescue_from_collateral` signs for.
 */
export interface ExpectedHelperConfig {
  triggerWad: bigint;
  targetWad: bigint;
  maxSlippageBps?: bigint;
  collateral: Address;
  poolFee: bigint;
}

/**
 * Why the borrower's setting at the helper does not match the keeper's, or null if it
 * does. The helper's values are the ones `unwind` enforces, so the keeper acts only
 * when its own agree with them, and refuses to start when they do not. A collateral or
 * pool fee that differs from the position's would make every `unwind` revert with
 * `TermsMismatch`.
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
  if (actual.collateral.toLowerCase() !== expected.collateral.toLowerCase()) {
    problems.push(
      `collateral ${actual.collateral} at the helper, ${expected.collateral} registered on NEAR`,
    );
  }
  if (actual.poolFee !== expected.poolFee) {
    problems.push(`pool fee ${actual.poolFee} at the helper, ${expected.poolFee} registered on NEAR`);
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

/** Uniswap v3-periphery QuoterV2, spec section 9. Not view on chain: it reverts inside
 *  to return its answer, so it is read with `eth_call` and declared view here. */
export const QUOTER_V2_ABI = parseAbi([
  'struct QuoteExactOutputSingleParams { address tokenIn; address tokenOut; uint256 amount; uint24 fee; uint160 sqrtPriceLimitX96; }',
  'function quoteExactOutputSingle(QuoteExactOutputSingleParams params) view returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);

/** The keeper's default headroom over a fresh quote when it sets `max_sold`. */
export const DEFAULT_QUOTE_TOLERANCE_BPS = 50n;

/** One endpoint's QuoterV2 answer for the sale, or why it gave none. */
export interface QuoteAnswer {
  rpc: string;
  /** Collateral base units the pool would take for exactly the USDC amount. */
  amountIn: bigint | null;
  error: string | null;
}

export interface QuoteTerms {
  /** USDC base units the unwind asks for. */
  amount: bigint;
  toleranceBps: bigint;
  /** Answers needed before the keeper trusts a quote. */
  minAnswers: number;
  /** Largest gap allowed between the lowest and highest answer, bps of the highest. */
  maxDeviationBps: bigint;
  /** The helper's own oracle bound, for the same amount: `maxIn` in `LeveeUnwind`. */
  oracleMaxIn: bigint;
}

export type MaxSoldChoice =
  | { ok: true; amountIn: bigint; maxSold: bigint }
  | {
      ok: false;
      reason: 'quote_unavailable' | 'quote_disagreement' | 'quote_over_slippage_bound';
      detail: string;
      amountIn: bigint | null;
    };

/**
 * `max_sold` from QuoterV2 answers, spec section 9. Pure, so `replay` can repeat it.
 *
 * Each endpoint quotes at its own latest block. The keeper needs at least `minAnswers`
 * that agree within `maxDeviationBps`, and takes the highest: one endpoint can stop an
 * unwind, as with the quorum, but cannot loosen the cap past what the others report.
 * A quote above the helper's oracle bound would revert on chain with SlippageExceeded,
 * so it is refused here instead.
 */
export function chooseMaxSold(answers: readonly QuoteAnswer[], terms: QuoteTerms): MaxSoldChoice {
  const quotes = answers.flatMap((answer) => (answer.amountIn === null ? [] : [answer.amountIn]));
  if (quotes.length < terms.minAnswers) {
    const errors = answers.map((answer) => `${answer.rpc}: ${answer.error ?? answer.amountIn}`);
    return {
      ok: false,
      reason: 'quote_unavailable',
      detail: `${quotes.length} of ${terms.minAnswers} quotes: ${errors.join('; ')}`,
      amountIn: null,
    };
  }
  const low = quotes.reduce((a, b) => (b < a ? b : a));
  const high = quotes.reduce((a, b) => (b > a ? b : a));
  if ((high - low) * BPS > high * terms.maxDeviationBps) {
    const seen = answers.map((answer) => `${answer.rpc}=${answer.amountIn}`).join(' ');
    return {
      ok: false,
      reason: 'quote_disagreement',
      detail: `quotes differ by more than ${terms.maxDeviationBps} bps: ${seen}`,
      amountIn: high,
    };
  }
  if (high > terms.oracleMaxIn) {
    return {
      ok: false,
      reason: 'quote_over_slippage_bound',
      detail: `the pool asks ${high} for ${terms.amount} USDC units, the helper allows ${terms.oracleMaxIn}`,
      amountIn: high,
    };
  }
  return { ok: true, amountIn: high, maxSold: (high * (BPS + terms.toleranceBps)) / BPS };
}

/**
 * `LeveeUnwind`'s `maxIn`: the most collateral the oracle bound lets the pool take for
 * `amount` USDC, rounded down as the helper rounds it.
 */
export function oracleMaxIn(
  amount: bigint,
  terms: { priceBase: bigint; decimals: bigint; maxSlippageBps: bigint },
  usdcPriceBase: bigint,
): bigint {
  if (terms.priceBase === 0n) return 0n;
  return (
    (amount * usdcPriceBase * 10n ** terms.decimals * (BPS + terms.maxSlippageBps)) /
    (terms.priceBase * USDC_UNIT * BPS)
  );
}
