import type { ReactNode } from "react";

export interface Column<Row> {
  label: string;
  /** At phone width this cell gets the whole line, for long text. */
  plain?: boolean;
  /** Tabular figures. */
  num?: boolean;
  cell: (row: Row) => ReactNode;
}

/**
 * A table of words that reflows to stacked rows at phone width. CSS display changes can strip table
 * semantics, so the roles are explicit and screen readers still get rows and headers.
 */
export function TextTable<Row>({ columns, rows, rowKey, label }: { columns: Column<Row>[]; rows: Row[]; rowKey: (row: Row) => string; label?: string }) {
  return (
    <div className="scroll">
      <table className="prose-table stack" role="table" aria-label={label}>
        <thead role="rowgroup">
          <tr role="row">
            {columns.map((column) => (
              <th key={column.label} scope="col" role="columnheader">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody role="rowgroup">
          {rows.map((row) => (
            <tr key={rowKey(row)} role="row">
              {columns.map((column) => (
                <td key={column.label} role="cell" data-label={column.label} data-plain={column.plain || undefined} className={column.num ? "num" : undefined}>
                  <span>{column.cell(row)}</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
