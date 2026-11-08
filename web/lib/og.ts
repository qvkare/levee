/** The link preview's alt text, from the same figures the image draws. tools/og-image.ts writes both. */
import type { Proof } from "./proof-model.ts";

export function ogAlt(proof: Proof): string {
  const p50 = ((proof.overall.p50Ms ?? 0) / 1000).toFixed(1);
  const chain = proof.replay?.chain ?? "testnet";
  return `Levee. When your health factor crosses the trigger, NEAR signs the repay. A real ${chain} rescue drawn on four lines: your position, the keeper, the Levee contract on NEAR and the MPC network. ${p50} s from detection to repay, the median of ${proof.overall.samples} testnet runs.\n`;
}
