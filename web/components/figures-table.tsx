import type { Figures } from "@/lib/wall.ts";
import { Num } from "./num.tsx";

function Row({ row }: { row: Figures }) {
  return (
    <>
      <tr className="fig-main">
        <td>{row.position}</td>
        <td className="strong">
          <Num>{row.distance}</Num>
        </td>
        <td>
          <Num>{row.health}</Num>
          <span className="wide-note">
            <Num>{row.healthNote}</Num>
          </span>
        </td>
        <td className="narrow-hide">
          <Num>{row.size}</Num>
        </td>
        <td className={`wide narrow-hide${row.backingQuiet ? " soft" : ""}`}>
          <Num>{row.backing}</Num>
        </td>
        <td>
          <Num>{row.liquidatesAt}</Num>
          <span className="wide-note">
            <Num>{row.liquidatesNote}</Num>
          </span>
        </td>
        <td className={`narrow-hide${row.repayQuiet ? " soft" : ""}`}>
          {row.repayStruck ? (
            <>
              <span className="vh">Levee cannot make this repay: </span>
              <s>
                <Num>{row.repay}</Num>
              </s>
            </>
          ) : (
            <Num>{row.repay}</Num>
          )}
        </td>
        <td className="narrow-hide">
          <Num>{row.levee}</Num>
        </td>
        <td className="wide narrow-hide">
          <Num>{row.readAt}</Num>
        </td>
      </tr>
      {/* At phone width four columns stay, and the rest of the row reads as one line under them. */}
      <tr className="fig-more">
        <td colSpan={4}>
          {row.size}. {row.backing}. Repay {row.repay}. {row.levee}. Read at {row.readAt}.
        </td>
      </tr>
    </>
  );
}

export function FiguresTable({ rows, target }: { rows: Figures[]; target: string }) {
  return (
    <div className="scroll">
      <table className="nums">
        <thead>
          <tr>
            <th scope="col">Position</th>
            <th scope="col">Distance</th>
            <th scope="col">Health, side</th>
            <th scope="col" className="narrow-hide">
              Size
            </th>
            <th scope="col" className="wide narrow-hide">
              Backing
            </th>
            <th scope="col">Liquidates at</th>
            <th scope="col" className="narrow-hide">
              Repay to reach {target}
            </th>
            <th scope="col" className="narrow-hide">
              Levee
            </th>
            <th scope="col" className="wide narrow-hide">
              Read at
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Row key={row.id} row={row} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
