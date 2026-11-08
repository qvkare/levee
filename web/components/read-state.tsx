"use client";

import Link from "next/link";
import { AddressForm } from "./address-form.tsx";
import { DistanceLine } from "./distance-line.tsx";

interface Props {
  title: string;
  body: string;
  /** What the box holds. */
  value?: string;
  /** Why that value was refused. */
  error?: string;
  /** A link to read the same address again. */
  retry?: string;
  /** Polite progress, for the loading state. */
  busy?: boolean;
}

/** A reading page with no reading: refused, limited or on its way. The line stands empty. */
export function ReadState({ title, body, value, error, retry, busy = false }: Props) {
  return (
    <main id="main" aria-busy={busy || undefined}>
      <div className="read-top">
        <div>
          <h1>{title}</h1>
          <p className="lede" role={busy ? "status" : undefined}>
            {body}
          </p>
          {retry && (
            <p className="who-line">
              <Link className="text-button" href={retry} prefetch={false}>
                Read again
              </Link>
            </p>
          )}
        </div>
        <AddressForm title={error ? "Try another address" : "Check another address"} value={value} error={error} />
      </div>
      <section className="read-band" aria-label="Distance to liquidation">
        <div className="band-head">
          <h2>Distance to liquidation</h2>
        </div>
        <DistanceLine points={[]} trigger={null} empty={busy ? "Reading" : "No reading"} />
      </section>
    </main>
  );
}
