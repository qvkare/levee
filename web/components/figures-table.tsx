import type { Figures } from "@/lib/line.ts";

function Row({ row }: { row: Figures }) {
  return (
    <tr>
      <th scope="row">{row.position}</th>
      <td className="strong">
        {row.distance}
        {row.meaning && <small>{row.meaning}</small>}
      </td>
      <td>
        {row.health}
        {row.healthNote && <small>{row.healthNote.trim()}</small>}
      </td>
      <td>{row.size}</td>
      <td className={row.backingQuiet ? "soft" : undefined}>{row.backing}</td>
      <td>
        {row.liquidatesAt}
        {row.liquidatesNote && <small>{row.liquidatesNote.replace(/^, /, "")}</small>}
      </td>
      <td className={row.repayQuiet ? "soft" : undefined}>
        {row.repayStruck ? (
          <>
            <span className="vh">Levee cannot make this repay: </span>
            <s>{row.repay}</s>
          </>
        ) : (
          row.repay
        )}
      </td>
      <td>{row.levee}</td>
      <td className="soft">{row.readAt}</td>
    </tr>
  );
}

/** Every figure for every position, in the line's order. Wide tables scroll inside themselves. */
export function FiguresTable({ rows, target }: { rows: Figures[]; target: string }) {
  return (
    <div className="scroll" tabIndex={0} role="region" aria-label="Every figure, by position">
      <table className="wide-table">
        <thead>
          <tr>
            <th scope="col">Position</th>
            <th scope="col">Distance</th>
            <th scope="col">Health, side</th>
            <th scope="col">Size</th>
            <th scope="col">Backing</th>
            <th scope="col">Liquidates at</th>
            <th scope="col">Repay to reach {target}</th>
            <th scope="col">Levee</th>
            <th scope="col">Read at</th>
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
