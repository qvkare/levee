"use client";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <section className="tool wrap">
      <h1>This page broke, and the fault is ours.</h1>
      <div className="prose">
        <p>No address data was lost, because this site stores none. Try again, or read the same figures from the API.</p>
        <p>
          <button className="button" type="button" onClick={reset}>
            Try again
          </button>
        </p>
      </div>
    </section>
  );
}
