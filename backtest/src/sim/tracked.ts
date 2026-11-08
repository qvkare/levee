// The keeper rule over a population path, and over several paths sharing one reserve.
//
// The rule is `simulate`'s, with one difference: the USDC cap uses the USDC debt on the path at
// each point, because a member that was not liquidated can borrow or repay USDC during the
// period. With a fixed share, `usdcDebt = usdcShare × debt` and the two agree; a test holds
// them to that. Pure functions, no I/O.
import { healthFactor, repayToTarget, type Landing, type Params, type Reason } from './simulate.ts';

export interface TrackedPoint {
  t: number;
  block: number;
  /** Collateral × liquidation threshold, USD. */
  capacity: number;
  /** Total debt, USD, with no Levee. */
  debt: number;
  /** The part of `debt` that native USDC can repay, USD. */
  usdcDebt: number;
}

export interface TrackedPath {
  /** Ascending in time. The first point with debt is the arming point. */
  points: TrackedPoint[];
  /** The real first liquidation in the period, or null if there was none. */
  liquidation: { block: number; t: number } | null;
}

export interface TrackedOutcome {
  /** Not liquidated in reality, or a repay landed first and HF held at or above 1 to the end. */
  saved: boolean;
  /** For a liquidated path only. Null when the position was not liquidated in reality. */
  reason: Reason | null;
  reserve: number;
  /** USD landed before the run stopped. */
  repaid: number;
  /** USD sent: landed, plus a repay still in flight when the run stopped. This is what the reserve gave up. */
  fired: number;
  landings: Landing[];
  firstDetection: number | null;
  armedBelowTrigger: boolean;
}

const EPSILON = 1e-9;

export function trackedArming(path: TrackedPath): TrackedPoint {
  const first = path.points.find((p) => p.debt > 0);
  if (!first) throw new Error('path has no debt');
  return first;
}

/** Per-position state while one or more positions draw on a reserve. */
interface Book {
  path: TrackedPath;
  armT: number;
  landed: number;
  inFlight: Landing | null;
  lastFire: number;
  landings: Landing[];
  firstDetection: number | null;
  failedAt: TrackedPoint | null;
  /** Reserve left anywhere when this position failed. */
  unspentAtFailure: number;
  armedBelowTrigger: boolean;
  /** Reserve fired for this position, landed or not. */
  fired: number;
}

function newBook(path: TrackedPath, trigger: number): Book {
  const arming = trackedArming(path);
  return {
    path,
    armT: arming.t,
    landed: 0,
    inFlight: null,
    lastFire: -Infinity,
    landings: [],
    firstDetection: null,
    failedAt: null,
    unspentAtFailure: NaN,
    armedBelowTrigger: healthFactor(arming.capacity, arming.debt) < trigger,
    fired: 0,
  };
}

/**
 * One observation of one position. `reserve.unspent` is shared by every position that draws on
 * it. Returns false once the position has failed, after which it takes no further steps.
 */
function step(book: Book, point: TrackedPoint, params: Params, reserve: { unspent: number }): boolean {
  if (point.t < book.armT) return true;
  if (book.inFlight && book.inFlight.landedAt < point.t) {
    book.landings.push(book.inFlight);
    book.landed += book.inFlight.amount;
    book.inFlight = null;
  }
  const debt = Math.max(0, point.debt - book.landed);
  const hf = healthFactor(point.capacity, debt);
  const liquidation = book.path.liquidation;
  const atOrAfterLiquidation = liquidation !== null && point.block >= liquidation.block;
  if (atOrAfterLiquidation && (hf < 1 || book.landed === 0)) {
    book.failedAt = point;
    book.unspentAtFailure = reserve.unspent;
    return false;
  }
  if (hf < params.trigger) {
    if (book.firstDetection === null && !atOrAfterLiquidation) book.firstDetection = point.t;
    const cooled = point.t - book.lastFire >= params.cooldownSec;
    if (!book.inFlight && cooled && reserve.unspent > EPSILON) {
      const repayable = Math.max(0, point.usdcDebt - book.landed);
      const amount = Math.min(repayToTarget(point.capacity, debt, params.target), reserve.unspent, repayable);
      if (amount > EPSILON) {
        book.inFlight = { detectedAt: point.t, landedAt: point.t + params.delaySec, amount };
        reserve.unspent -= amount;
        book.fired += amount;
        book.lastFire = point.t;
      }
    }
  }
  return true;
}

function outcomeOf(book: Book, reserve: number): TrackedOutcome {
  const repaid = book.landings.reduce((sum, l) => sum + l.amount, 0);
  const base = { reserve, repaid, fired: book.fired, landings: book.landings, firstDetection: book.firstDetection, armedBelowTrigger: book.armedBelowTrigger };
  const liquidation = book.path.liquidation;
  if (liquidation === null) return { ...base, saved: true, reason: null };
  if (!book.failedAt) return { ...base, saved: true, reason: 'saved' };
  const landedFirst = book.landings.some((l) => l.landedAt < liquidation.t);
  let reason: Reason;
  if (book.firstDetection === null) reason = 'no_warning';
  else if (!landedFirst) reason = 'too_slow';
  else if (book.unspentAtFailure <= EPSILON) reason = 'reserve_empty';
  else if (repaid >= book.failedAt.usdcDebt - EPSILON) reason = 'usdc_debt_exhausted';
  else reason = 'follow_up_too_slow';
  return { ...base, saved: false, reason };
}

/** One position, one reserve of `reserveShare` × debt at arming. */
export function simulateTracked(path: TrackedPath, params: Params): TrackedOutcome {
  const book = newBook(path, params.trigger);
  const reserve = params.reserveShare * trackedArming(path).debt;
  const shared = { unspent: reserve };
  for (const point of path.points) if (!step(book, point, params, shared)) break;
  return outcomeOf(book, reserve);
}

/**
 * Several positions draw on one reserve of `budget` USD, first come, first served. Points of
 * all positions run in time order; on a tie, in the order the paths were given. Each position
 * has its own repay in flight and its own cooldown, as each has its own rescuer in the spec.
 * `params.reserveShare` is ignored: the budget is given.
 */
export function simulateShared(paths: TrackedPath[], budget: number, params: Params): TrackedOutcome[] {
  const books = paths.map((path) => newBook(path, params.trigger));
  const shared = { unspent: budget };
  const queue: Array<{ t: number; position: number; index: number }> = [];
  paths.forEach((path, position) => path.points.forEach((point, index) => queue.push({ t: point.t, position, index })));
  queue.sort((a, b) => a.t - b.t || a.position - b.position || a.index - b.index);
  const live = books.map(() => true);
  for (const { position, index } of queue) {
    if (!live[position]) continue;
    live[position] = step(books[position]!, paths[position]!.points[index]!, params, shared);
  }
  return books.map((book) => outcomeOf(book, budget));
}

/** The upfront bound for a tracked path: `amount` repays USDC debt at arming, capped at the USDC debt on the path. */
export function survivesUpfront(path: TrackedPath, amount: number): boolean {
  if (path.liquidation === null) return true;
  let minHf = Infinity;
  for (const point of path.points) {
    if (point.block < path.liquidation.block) continue;
    minHf = Math.min(minHf, healthFactor(point.capacity, Math.max(0, point.debt - Math.min(amount, point.usdcDebt))));
  }
  return minHf >= 1;
}
