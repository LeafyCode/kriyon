import { type CSSProperties, Fragment, type ReactNode } from "react";
import { tokens } from "../../theme/tokens.ts";
import { Section } from "../chrome.tsx";

const listStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "10px",
};

const emptyStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "12.5px",
};

/**
 * An Inspector section rendering a list of `items` under a label + optional
 * meta, or an `empty` message when there are none. Owns the section wrapper,
 * list layout, and empty state; each panel supplies only its row renderer.
 */
export function ListPanel<T>({
  first,
  label,
  meta,
  items,
  empty,
  getKey,
  renderItem,
}: {
  first?: boolean;
  label: string;
  meta?: ReactNode;
  items: T[];
  empty: string;
  getKey: (item: T, index: number) => string | number;
  renderItem: (item: T) => ReactNode;
}) {
  return (
    <Section first={first} label={label} meta={meta}>
      {items.length === 0 ? (
        <span style={emptyStyle}>{empty}</span>
      ) : (
        <div style={listStyle}>
          {items.map((item, index) => (
            <Fragment key={getKey(item, index)}>{renderItem(item)}</Fragment>
          ))}
        </div>
      )}
    </Section>
  );
}
