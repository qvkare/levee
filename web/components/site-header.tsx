import Link from "next/link";
import type { ReactNode } from "react";
import { AddressForm } from "./address-form.tsx";

export function Brand() {
  return (
    <Link href="/" className="brand" prefetch={false}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/levee-mark.svg" width={31} height={31} alt="" />
      Levee
    </Link>
  );
}

/** The header row: mark and wordmark in the label column, then the address box, as in a search engine. */
export function SiteHeader({ shown, value, error, here }: { shown?: string; value?: string; error?: string | null; here?: "how" | "proof" }) {
  return (
    <header className="head">
      <Brand />
      <AddressForm shown={shown} value={value} error={error} />
      <nav className="links" aria-label="Main">
        <Link href="/how" prefetch={false} aria-current={here === "how" ? "page" : undefined}>
          <span className="wide">How a rescue runs</span>
          <span className="narrow">How</span>
        </Link>
        <Link href="/how#limits" prefetch={false} className="hide-narrow">
          Limits
        </Link>
        <Link href="/proof" prefetch={false} aria-current={here === "proof" ? "page" : undefined}>
          Proof
        </Link>
      </nav>
    </header>
  );
}

/** In the last 5% the header gives way: the mark, and one way out. */
export function BareHeader({ children }: { children: ReactNode }) {
  return (
    <header className="head head-bare">
      <Brand />
      <div className="links">{children}</div>
    </header>
  );
}
