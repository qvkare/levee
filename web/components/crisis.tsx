import type { CSSProperties, ReactNode } from "react";
import type { CrisisModel } from "@/lib/line.ts";
import { LAST_STRETCH } from "@/lib/math.ts";

/**
 * The last 5%. The reading's band turns amber, the line zooms to its last 5%, and everything else at
 * the address is two lines. Only the reading or a simulation sets it. The caller says which.
 */
export function CrisisBand({ model, distance, lead, children }: { model: CrisisModel; distance: number; lead: ReactNode; children?: ReactNode }) {
  const at = Math.min(1, Math.max(0, distance / LAST_STRETCH));
  return (
    <section className="crisis" aria-labelledby="crisis-h">
      <p className="crisis-tag">Inside the last 5%</p>
      <h1 id="crisis-h">
        {model.name} is {model.percent} from liquidation
      </h1>
      <div className="crisis-line" aria-hidden="true">
        <span className="crisis-end">Liquidation</span>
        <span className="crisis-bar">
          <span className="crisis-mark" style={{ left: `${at * 100}%` } as CSSProperties}>
            <b>{model.percent}</b>
          </span>
        </span>
        <span className="crisis-end crisis-end-r">5%</span>
      </div>
      <div className="crisis-grid">
        <div>
          <p>{lead}</p>
          <p>{model.sentence}</p>
          {model.hollow && <p>Levee cannot reach this position.</p>}
        </div>
        <div>
          <dl>
            {model.figures.map((figure) => (
              <div key={figure.label}>
                <dt>{figure.label}</dt>
                <dd>{figure.value}</dd>
              </div>
            ))}
          </dl>
          <p className="rest">
            {model.rest[0]} {model.rest[1]}
          </p>
          {children}
        </div>
      </div>
    </section>
  );
}
