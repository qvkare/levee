import type { ReactNode } from "react";
import type { CrisisModel } from "@/lib/wall.ts";

/**
 * The last 5%. The number takes the page, and everything else at the address is two lines. The
 * caller says what this is: a reading or a simulation.
 */
export function CrisisView({ lead, model }: { lead: ReactNode; model: CrisisModel }) {
  return (
    <div className="crisis">
      <div className="now">
        <p className="lead">{lead}</p>
        <p className="rest">
          {model.rest[0]}
          {model.rest[1] && (
            <>
              <br />
              {model.rest[1]}
            </>
          )}
        </p>
      </div>
      <p className="crit" data-hollow={model.hollow || undefined}>
        {model.percent}
      </p>
      <div className="then">
        <p>{model.sentence}</p>
        <dl>
          {model.figures.map((figure) => (
            <div key={figure.label}>
              <dt>{figure.label}</dt>
              <dd>{figure.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
