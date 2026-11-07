import { SiteHeader } from "@/components/site-header.tsx";
import { Axis } from "@/components/wall.tsx";

export default function Loading() {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <div className="board">
          <div className="empty" role="status">
            <h1 className="lead-title">Reading this address.</h1>
            <p>Aave on Base, Aave on Arbitrum and Hyperliquid, each with a few seconds to answer.</p>
          </div>
          <Axis />
        </div>
      </main>
    </>
  );
}
