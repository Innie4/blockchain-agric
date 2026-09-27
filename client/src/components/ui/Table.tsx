import type { ReactNode } from "react";

export interface TableColumn<T> {
  /** Stable key, also used as the column's class hook. */
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  align?: "left" | "center" | "right";
  /** Renders this column's cells as row headers, for the identifying column. */
  isRowHeader?: boolean;
  width?: string;
  cellClassName?: string;
}

export interface TableProps<T> {
  /**
   * A real caption. It is the table's accessible name, so it must describe what
   * the rows are rather than repeat the page heading.
   */
  caption: string;
  columns: readonly TableColumn<T>[];
  rows: readonly T[];
  rowKey: (row: T, index: number) => string;
  /**
   * An extra class for a row that needs attention, so a flagged entry is
   * distinguishable at a glance and not only from the cell beside it.
   */
  rowClassName?: (row: T) => string | undefined;
  /** Visually hidden when the caption is already stated in the page heading. */
  captionHidden?: boolean;
  compact?: boolean;
  emptyState?: ReactNode;
  /** Defaults to the caption. */
  ariaLabel?: string;
  className?: string;
}

/**
 * A semantic data table inside a scroll container.
 *
 * The container is focusable and labelled, because on a narrow screen a table
 * that scrolls sideways is otherwise unreachable by keyboard. The caption is
 * always present, which is what gives the table a name.
 */
export function Table<T>({
  caption,
  columns,
  rows,
  rowKey,
  rowClassName,
  captionHidden = false,
  compact = false,
  emptyState,
  ariaLabel,
  className,
}: TableProps<T>) {
  const classes = ["table", compact ? "table--compact" : null, className]
    .filter((value): value is string => value !== null && value !== undefined)
    .join(" ");

  return (
    <div
      className="table-scroll"
      role="region"
      aria-label={ariaLabel ?? caption}
      tabIndex={0}
    >
      <table className={classes}>
        <caption className={captionHidden ? "visually-hidden" : undefined}>{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                data-align={column.align}
                {...(column.width === undefined ? {} : { style: { width: column.width } })}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length}>
                {emptyState ?? <p className="text-secondary text-sm">Nothing to show yet.</p>}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => (
              <tr key={rowKey(row, index)} className={rowClassName?.(row)}>
                {columns.map((column) =>
                  column.isRowHeader === true ? (
                    <th
                      key={column.key}
                      scope="row"
                      data-align={column.align}
                      className={["table__primary", column.cellClassName]
                        .filter((value): value is string => value !== null && value !== undefined)
                        .join(" ")}
                    >
                      {column.render(row)}
                    </th>
                  ) : (
                    <td
                      key={column.key}
                      data-align={column.align}
                      className={column.cellClassName}
                    >
                      {column.render(row)}
                    </td>
                  ),
                )}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
