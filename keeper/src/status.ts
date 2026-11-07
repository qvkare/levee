/** The `status` command. Read-only: it needs no keys and sends nothing. */
import { formatUnits } from 'viem';
import { decide, formatWad } from './decision.js';
import { DEFAULT_QUORUM, type Sample, readQuorum } from './quorum.js';
import { capsFor, decisionInputFor } from './rescue.js';
import type { Wiring } from './setup.js';

const usd = (base: bigint): string => `$${formatUnits(base, 8)}`;
const usdc = (units: bigint): string => `${formatUnits(units, 6)} USDC`;

function sampleLine(sample: Sample): string {
  return `  ${sample.rpc}: block ${sample.blockNumber}, health factor ${formatWad(sample.healthFactor)}`;
}

export async function describePosition(wiring: Wiring, now: () => number): Promise<string> {
  const { target, chain, position, borrower, rescuer, clients } = wiring;
  const query = { pool: chain.pool, usdc: chain.usdc, borrower, rescuer };
  const quorum = await readQuorum(
    clients.map((client) => ({ url: client.url, read: () => client.readSample(query) })),
    { ...DEFAULT_QUORUM, chainId: chain.chainId },
    now,
  );

  const lines = [
    `Position ${target.id} on ${chain.name}`,
    `  borrower ${borrower}`,
    `  rescuer  ${rescuer}`,
    `  trigger ${target.trigger}, target ${target.target}`,
    ...quorum.samples.map(sampleLine),
    ...quorum.failures.map((failure) => `  ${failure.rpc}: ${failure.error}`),
  ];

  if (!quorum.ok) {
    lines.push(`  quorum refused: ${quorum.reason}: ${quorum.detail}`);
    return lines.join('\n');
  }

  const { sample } = quorum;
  const caps = capsFor(position, sample, quorum.nowMs);
  const decision = decide(decisionInputFor(sample, caps, target.triggerWad, target.targetWad));
  lines.push(
    '  quorum ok',
    `  collateral ${usd(sample.totalCollateralBase)}, debt ${usd(sample.totalDebtBase)}, USDC debt ${usdc(sample.usdcDebt)}`,
    `  rescuer holds ${usdc(sample.rescuerUsdc)}, allowance ${usdc(sample.rescuerAllowance)}`,
    `  caps: ${usdc(caps.maxPerRescue)} per rescue, ${usdc(caps.remainingToday)} left today, cooldown ${caps.cooldownRemainingSecs}s, paused ${caps.paused}`,
    decision.action === 'repay'
      ? `  would repay ${usdc(decision.amount)}, limited by ${decision.limitedBy}`
      : `  no action: ${decision.reason}`,
  );
  return lines.join('\n');
}
