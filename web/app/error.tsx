"use client";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main id="main">
      <h1>This page broke, and the fault is ours.</h1>
      <p>No address data was lost, because this site stores none. Try again, or read the same figures from the API.</p>
      <button type="button" onClick={reset}>
        Try again
      </button>
    </main>
  );
}
