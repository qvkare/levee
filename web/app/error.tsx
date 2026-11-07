"use client";

import { SiteHeader } from "@/components/site-header.tsx";
import { Axis } from "@/components/wall.tsx";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <div className="board">
          <div className="empty">
            <h1 className="lead-title">This page broke, and the fault is ours.</h1>
            <p>No address data was lost, because this site stores none. Try again, or read the same figures from the API.</p>
            <p>
              <button className="text-button" type="button" onClick={reset}>
                Try again
              </button>
            </p>
          </div>
          <Axis />
        </div>
      </main>
    </>
  );
}
