import { CONTRACT_ID } from "@/lib/links.ts";
import type { LaneKey } from "./badge.tsx";

interface Board {
  lane: LaneKey;
  name: string;
  role: string;
  can: string[];
  /** The heading of the second list: what it cannot do, or what it is trusted with. */
  limit: string;
  limits: string[];
}

const BOARDS: Board[] = [
  { lane: "P", name: "You", role: "Owner, NEAR account", can: ["Register, set caps, pause", "Withdraw the reserve, only to the registered borrower"], limit: "Can’t", limits: ["Be bypassed by the keeper"] },
  { lane: "K", name: "Keeper", role: "Key limited to rescue", can: ["Ask for a repay within your caps", "Fire early"], limit: "Can’t", limits: ["Change destination, asset or borrower", "Exceed caps or withdraw"] },
  { lane: "N", name: "Levee contract", role: CONTRACT_ID, can: ["Sign approve, repay and transfer, each to a fixed target"], limit: "Can’t", limits: ["Sign arbitrary payloads", "Read the lending chain, so the trigger lives with the keeper"] },
  { lane: "M", name: "MPC network", role: "NEAR Chain Signatures", can: ["Sign for the derived rescuer address"], limit: "Trusted with", limits: ["Custody of the rescuer key. Levee puts no limit on it, and that trust stays."] },
];

/** One board per line: what each actor can do, and where it stops. */
export function Boards() {
  return (
    <div className="boards">
      {BOARDS.map((board) => (
        <article key={board.lane} className={`board c-${board.lane}`} aria-labelledby={`board-${board.lane}`}>
          <header>
            <span className="badge badge-on" aria-hidden="true">
              {board.lane}
            </span>
            <div>
              <h3 id={`board-${board.lane}`}>{board.name}</h3>
              <p>{board.role}</p>
            </div>
          </header>
          <div className="board-body">
            <h4>Can</h4>
            <ul>
              {board.can.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <h4>{board.limit}</h4>
            <ul className="no">
              {board.limits.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </article>
      ))}
    </div>
  );
}

export function WorstCase() {
  return (
    <p className="worst">
      <span className="worst-tag">Worst case</span>
      <span>
        <b>With a stolen keeper key</b>, someone can repay your own debt early, spend rescuer gas up to the fee ceiling, or use up the day’s budget.
      </span>
    </p>
  );
}

