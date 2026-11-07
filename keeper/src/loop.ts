/** The `run` command: one pass per position every five seconds, spec section 5. */
import { formatWad } from './decision.js';
import { type RescueContext, type TickResult, tick } from './rescue.js';

export const LOOP_INTERVAL_MS = 5_000;

/** A refusal can repeat every five seconds, and one record per window says it all. */
export const ABORT_RECORD_WINDOW_MS = 300_000;

export function createAbortThrottle(
  now: () => number,
  windowMs: number,
): (reason: string) => boolean {
  const lastRecorded = new Map<string, number>();
  return (reason) => {
    const last = lastRecorded.get(reason);
    const at = now();
    if (last !== undefined && at - last < windowMs) return false;
    lastRecorded.set(reason, at);
    return true;
  };
}

function describe(id: number, result: TickResult): string {
  switch (result.status) {
    case 'idle': {
      const health = result.healthFactor === null ? '' : ` at ${formatWad(result.healthFactor)}`;
      return `position ${id}: ${result.reason}${health}`;
    }
    case 'quiet':
      return `position ${id}: ${result.reason} again, already on record`;
    case 'recorded':
      return `position ${id}: ${result.run.outcome}, ${result.run.run_id}`;
  }
}

const abortableSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * Watches one position until the signal aborts. Passes never overlap, so a rescue that
 * is still in flight cannot be started a second time. A pass can only throw if the
 * record itself could not be written, and that must not stop the watch.
 */
export async function watchPosition(
  ctx: RescueContext,
  signal: AbortSignal,
  intervalMs: number = LOOP_INTERVAL_MS,
): Promise<void> {
  const watched: RescueContext = {
    ...ctx,
    allowAbortRecord: createAbortThrottle(ctx.now, ABORT_RECORD_WINDOW_MS),
  };
  while (!signal.aborted) {
    try {
      ctx.log(describe(ctx.position.id, await tick(watched)));
    } catch (error) {
      ctx.log(`position ${ctx.position.id}: pass failed: ${error}`);
    }
    await abortableSleep(intervalMs, signal);
  }
}
