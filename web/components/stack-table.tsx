import type { ReactNode } from "react";

export interface Column<Row> {
  label: string;
  numeric?: boolean;
  /** Takes the full width when the table is stacked at phone width. */
  wide?: boolean;
  cell: (row: Row) => ReactNode;
  emphasis?: (row: Row) => boolean;
}

/**
 * A table that reflows to stacked rows at phone width. CSS display changes can strip table
 * semantics, so the roles are explicit and screen readers still get rows and headers.
 */
export function StackTable<Row>({
  caption,
  columns,
  rows,
  rowKey,
  phone = "stack",
}: {
  caption?: ReactNode;
  columns: Column<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  /** stack: two cells a line. stack-3: three, for long rows. table: stays a table, for short rows. */
  phone?: "stack" | "stack-3" | "table";
}) {
  return (
    <table className={phone === "table" ? undefined : phone === "stack-3" ? "stack stack-3" : "stack"} role="table">
      {caption && <caption>{caption}</caption>}
      <thead role="rowgroup">
        <tr role="row">
          {columns.map((column) => (
            <th key={column.label} scope="col" role="columnheader" className={column.numeric ? "num" : undefined}>
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody role="rowgroup">
        {rows.map((row) => (
          <tr key={rowKey(row)} role="row">
            {columns.map((column) => (
              <td
                key={column.label}
                role="cell"
                data-label={column.label}
                data-wide={column.wide ? "true" : undefined}
                className={[column.numeric ? "num" : "", column.emphasis?.(row) ? "flood-text" : ""].filter(Boolean).join(" ") || undefined}
              >
                {column.cell(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
