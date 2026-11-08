import Link from "next/link";

export default function NotFound() {
  return (
    <main id="main" className="page-head end-page">
      <div className="end-line" aria-hidden="true">
        <span className="track" />
        <span className="dot" />
        <span className="track" />
      </div>
      <h1>The line has no stop here</h1>
      <p className="lede">This page does not exist. Paste an address to read it, or take one of these.</p>
      <p className="links-row">
        <Link href="/" prefetch={false}>
          Home and the address box
        </Link>
        <Link href="/how" prefetch={false}>
          How a rescue runs
        </Link>
        <Link href="/proof" prefetch={false}>
          Proof
        </Link>
      </p>
    </main>
  );
}
