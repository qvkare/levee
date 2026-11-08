import Link from "next/link";
import { seconds } from "@/lib/format.ts";
import { debtAssets, type LineEntry } from "@/lib/line.ts";

/** The testnet median, passed in so the browser bundle does not carry every figure. */
export interface Measured {
  p50Ms: number | null;
  samples: number;
}

function FirstPosition({ first }: { first: LineEntry | undefined }) {
  if (!first) return <p>There is no debt here for Levee to repay.</p>;
  if (first.kind === "aave" && first.reach === "none") {
    return (
      <p>
        <b>Nothing, for {first.name}.</b> Levee repays USDC debt on Aave, and this debt is {debtAssets(first.position)}. A reserve, a trigger and a keeper would change nothing here.
      </p>
    );
  }
  if (first.kind === "perp") {
    return (
      <p>
        <b>Nothing yet, for {first.name}.</b> Levee repays Aave debt. Hyperliquid top-ups are a separate phase and are not live, so this page gives the distance and stops there.
      </p>
    );
  }
  return (
    <p>
      <b>For {first.name}:</b> when health factor crosses a trigger you set, a keeper asks a NEAR contract to sign one thing, a repay of this debt from your USDC reserve, inside caps you set. The position stays in your wallet, and the keeper can’t send funds anywhere else.
    </p>
  );
}

/** What the product would do for the nearest position at this address, including when that is nothing. */
export function LeveeNote({ first, measured }: { first: LineEntry | undefined; measured: Measured }) {
  return (
    <div className="note note-plain levee-note">
      <h2 className="sub-h">What Levee would do here</h2>
      <FirstPosition first={first} />
      <p>
        <b>This page only reads.</b> Nothing is repaying these positions.
        {measured.p50Ms !== null && ` On testnet a rescue took a median ${seconds(measured.p50Ms)} from detection to inclusion, over ${measured.samples} runs.`}{" "}
        <Link href="/how">How a rescue runs</Link>
      </p>
    </div>
  );
}
