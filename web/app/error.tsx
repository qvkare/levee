"use client";

import Link from "next/link";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main id="main" className="page-head end-page">
      <div className="end-line" aria-hidden="true">
        <span className="track" />
        <span className="dot" />
        <span className="track" />
      </div>
      <h1>This page broke, and the fault is ours</h1>
      <p className="lede">This site stores no address data, so nothing was lost. Try again, or read the same figures from the JSON API.</p>
      <p className="links-row">
        <button className="button" type="button" onClick={reset}>
          Try again
        </button>
        <Link href="/how#api" prefetch={false}>
          The JSON API
        </Link>
        <Link href="/" prefetch={false}>
          Home
        </Link>
      </p>
    </main>
  );
}
