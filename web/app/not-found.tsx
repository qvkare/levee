import { SiteHeader } from "@/components/site-header.tsx";
import { Axis } from "@/components/wall.tsx";

export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <div className="board">
          <div className="empty">
            <h1 className="lead-title">There is no page here. Paste an address instead.</h1>
          </div>
          <Axis />
        </div>
      </main>
    </>
  );
}
