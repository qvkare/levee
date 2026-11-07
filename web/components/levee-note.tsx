import Link from "next/link";
import { debtAssets, type WallEntry } from "@/lib/wall.ts";

function FirstRow({ first }: { first: WallEntry | undefined }) {
  if (first?.reach === "none" && first.kind === "aave") {
    return (
      <>
        <h2>What Levee does with the first row: nothing.</h2>
        <p>Levee repays USDC debt on Aave, and this debt is {debtAssets(first.position)}. A reserve, a trigger and a keeper would change nothing here.</p>
      </>
    );
  }
  if (first?.kind === "perp") {
    return (
      <>
        <h2>What Levee does with the first row: nothing yet.</h2>
        <p>Levee repays Aave debt. Hyperliquid top-ups are a separate phase and are not live, so this page only tells you the distance.</p>
      </>
    );
  }
  return (
    <>
      <h2>What Levee does with the first row.</h2>
      <p>
        When a health factor crosses a trigger you set, a keeper asks a NEAR contract to sign one thing: repay this debt from your reserve, within caps you set. The position stays in your wallet, and the
        keeper cannot send funds anywhere else. <Link href="/how">How a rescue runs</Link>.
      </p>
    </>
  );
}

/** Says what the product does for the top of this wall, including when that is nothing. */
export function LeveeNote({ first }: { first: WallEntry | undefined }) {
  return (
    <div>
      <FirstRow first={first} />
      <p>
        <b>This page only reads.</b> Nothing is repaying these positions. Levee is unaudited, and its live runs are on testnet: do not use it with funds you cannot lose.
      </p>
    </div>
  );
}
