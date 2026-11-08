/** The `status` command. Read-only: it needs no keys and sends nothing. */
import { formatUnits } from 'viem';
import { decide, formatWad } from './decision.js';
import { DEFAULT_QUORUM, type Sample, readQuorum } from './quorum.js';
import { capsFor, collateralDecisionInputFor, decisionInputFor } from './rescue.js';
import type { Wiring } from './setup.js';
import { helperConfigMismatch } from './unwind.js';

const usd = (base: bigint): string => `$${formatUnits(base, 8)}`;
const usdc = (units: bigint): string => `${formatUnits(units, 6)} USDC`;

function sampleLine(sample: Sample): string {
  return `  ${sample.rpc}: block ${sample.blockNumber}, health factor ${formatWad(sample.healthFactor)}`;
}

export async function describePosition(wiring: Wiring, now: () => number): Promise<string> {
  const { target, chain, position, borrower, rescuer, clients, collateral } = wiring;
  const query = {
    pool: chain.pool,
    usdc: chain.usdc,
    borrower,
    rescuer,
    ...(collateral ? { collateral: { asset: collateral.asset, helper: collateral.helper } } : {}),
  };
  const quorum = await readQuorum(
    clients.map((client) => ({ url: client.url, read: () => client.readSample(query) })),
    { ...DEFAULT_QUORUM, chainId: chain.chainId },
    now,
  );

  const lines = [
    `Position ${target.id} on ${chain.name}, ${collateral ? 'collateral' : 'reserve'} mode`,
    `  borrower ${borrower}`,
    `  rescuer  ${rescuer}`,
    `  trigger ${target.trigger}, target ${target.target}`,
    ...(collateral
      ? [
          `  sells ${collateral.asset} through ${collateral.helper}, pool fee ${collateral.poolFee}, slippage up to ${target.maxSlippageBps} bps`,
        ]
      : []),
    ...quorum.samples.map(sampleLine),
    ...quorum.failures.map((failure) => `  ${failure.rpc}: ${failure.error}`),
  ];

  if (!quorum.ok) {
    lines.push(`  quorum refused: ${quorum.reason}: ${quorum.detail}`);
    return lines.join('\n');
  }

  const { sample } = quorum;
  const caps = capsFor(position, sample, quorum.nowMs);
  lines.push(
    '  quorum ok',
    `  collateral ${usd(sample.totalCollateralBase)}, debt ${usd(sample.totalDebtBase)}, USDC debt ${usdc(sample.usdcDebt)}`,
  );

  if (collateral) {
    const held = sample.collateral;
    if (!held) {
      lines.push('  collateral not read');
      return lines.join('\n');
    }
    const units = (value: bigint) => formatUnits(value, Number(held.decimals));
    lines.push(
      `  borrower holds ${units(held.aTokenBalance)} in aTokens, ${units(held.aTokenAllowance)} approved to the helper`,
    );
    const mismatch = helperConfigMismatch(
      target,
      {
        rescuer: held.authorizedRescuer,
        maxSlippageBps: held.maxSlippageBps,
        triggerHf: held.triggerHf,
        targetHf: held.targetHf,
      },
      rescuer,
    );
    if (mismatch) {
      lines.push(`  helper config differs: ${mismatch}`);
      return lines.join('\n');
    }
  } else {
    lines.push(
      `  rescuer holds ${usdc(sample.rescuerUsdc)}, allowance ${usdc(sample.rescuerAllowance)}`,
    );
  }

  const input = collateral
    ? collateralDecisionInputFor(sample, caps, collateral.poolFee)
    : decisionInputFor(sample, caps, target.triggerWad, target.targetWad);
  const decision = decide(input);
  lines.push(
    `  caps: ${usdc(caps.maxPerRescue)} per rescue, ${usdc(caps.remainingToday)} left today, cooldown ${caps.cooldownRemainingSecs}s, paused ${caps.paused}`,
    decision.action === 'repay'
      ? `  would repay ${usdc(decision.amount)}, limited by ${decision.limitedBy}`
      : `  no action: ${decision.reason}`,
  );
  return lines.join('\n');
}
