import { CONTRACT_ID } from "@/lib/links.ts";

/** A lane's letter, U for the helper, which is ink like the terminus, and O for the owner, who has no lane. */
type BoardKey = "P" | "K" | "N" | "M" | "U" | "O";

interface Board {
  key: BoardKey;
  name: string;
  role: string;
  can: string[];
  /** The heading of the second list: what it cannot do, or what it is trusted with. */
  limit?: string;
  limits?: string[];
}

/** README, "What each key can do". */
const BOARDS: Board[] = [
  {
    key: "P",
    name: "Borrower",
    role: "Your wallet, on the lending chain",
    can: ["Authorize LeveeUnwind with your trigger, target, price bound, collateral and pool", "Set the aToken allowance to it", "Revoke at once, without NEAR"],
  },
  {
    key: "U",
    name: "LeveeUnwind",
    role: "The helper on Base. No owner",
    can: ["Sell your authorized collateral, in your authorized pool, to repay your USDC debt, below your trigger"],
    limit: "Can’t",
    limits: ["Act for anyone else", "Change its terms", "Be upgraded"],
  },
  {
    key: "K",
    name: "Keeper",
    role: "Key limited to rescue_from_collateral",
    can: ["Ask for a repay within caps", "Set max_sold", "Fire early"],
    limit: "Can’t",
    limits: ["Change the destination, asset, pool or borrower", "Exceed caps", "Loosen your price bound", "Withdraw"],
  },
  {
    key: "N",
    name: "Levee contract",
    role: CONTRACT_ID,
    can: ["Sign unwind to the registered helper", "Sign approve, repay and transfer, each to a fixed target"],
    limit: "Can’t",
    limits: ["Sign arbitrary payloads", "Change its code: it has no keys"],
  },
  {
    key: "M",
    name: "MPC network",
    role: "NEAR Chain Signatures",
    can: ["Sign for the derived rescuer address"],
    limit: "Trusted with",
    limits: ["Custody of the rescuer key. Levee puts no limit on it, and that trust stays."],
  },
  {
    key: "O",
    name: "Owner",
    role: "The NEAR account that registers",
    can: ["Register a position, set caps, pause", "Approve, and withdraw float only to the registered borrower"],
  },
];

/** One board per actor: what each can do, and where it stops. */
export function Boards() {
  return (
    <div className="boards">
      {BOARDS.map((board) => (
        <article key={board.key} className={`board c-${board.key}`} aria-labelledby={`board-${board.key}`}>
          <header>
            <span className="badge badge-on" aria-hidden="true">
              {board.key}
            </span>
            <div>
              <h3 id={`board-${board.key}`}>{board.name}</h3>
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
            {board.limit && board.limits && (
              <>
                <h4>{board.limit}</h4>
                <ul className="no">
                  {board.limits.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </>
            )}
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
        <b>A stolen keeper key</b> can act only while your health factor is below your trigger, only on the collateral and pool you named, and not much past your target. Each sale is at most your bound worse than Aave’s oracle, up to the daily cap. It can also burn rescuer gas up to the fee ceiling. <code>revoke()</code> or a zero allowance stops it at once.
      </span>
    </p>
  );
}
