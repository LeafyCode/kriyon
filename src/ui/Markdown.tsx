/**
 * Markdown as React elements, for Claude's replies and for release notes:
 * the slice `parseReply` reads. URLs open in the browser; file paths open as
 * the terminal's do only under a {@link LinkCwd} folder, and stay text
 * without one.
 */

import { Check, Copy } from "lucide-react";
import {
  type CSSProperties,
  createContext,
  Fragment,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import {
  type Align,
  type Block,
  type Inline,
  parseReply,
} from "../structured/replyMarkdown.ts";
import { linkTarget, openLinkTarget } from "../terminal/links.ts";
import { button } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import { copyText } from "./copyText.ts";

export const replyStyle: CSSProperties = {
  color: tokens.color.ink.primary,
  fontSize: "14px",
  lineHeight: 1.65,
  margin: 0,
  whiteSpace: "pre-wrap",
};

const replyBlocksStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: tokens.space.md,
};

const listStyle: CSSProperties = {
  ...replyStyle,
  display: "flex",
  flexDirection: "column",
  gap: tokens.space.xs,
  paddingLeft: tokens.space.xl,
};

const headingStyle: CSSProperties = {
  ...replyStyle,
  color: tokens.color.ink.bright,
  fontWeight: 600,
};

const codeBlockStyle: CSSProperties = {
  background: tokens.color.blockWell,
  borderRadius: tokens.radius.md,
  color: tokens.color.ink.primary,
  fontFamily: tokens.font.mono,
  fontSize: "12px",
  lineHeight: 1.55,
  margin: 0,
  overflowX: "auto",
  padding: `${tokens.space.sm} ${tokens.space.md}`,
  whiteSpace: "pre",
};

// Wide tables scroll inside the reply rather than widening it.
const tableWrapStyle: CSSProperties = {
  overflowX: "auto",
};

const tableStyle: CSSProperties = {
  ...replyStyle,
  borderCollapse: "collapse",
  whiteSpace: "normal",
};

const cellStyle: CSSProperties = {
  borderBottom: `1px solid ${tokens.color.line.soft}`,
  padding: `${tokens.space.xs} ${tokens.space.md} ${tokens.space.xs} 0`,
  textAlign: "left",
  verticalAlign: "top",
};

const headCellStyle: CSSProperties = {
  ...cellStyle,
  borderBottom: `1px solid ${tokens.color.line.strong}`,
  color: tokens.color.ink.bright,
  fontWeight: 600,
};

const ruleStyle: CSSProperties = {
  border: 0,
  borderTop: `1px solid ${tokens.color.line.base}`,
  margin: 0,
  width: "100%",
};

const inlineCodeStyle: CSSProperties = {
  background: tokens.color.blockWell,
  borderRadius: tokens.radius.sm,
  fontFamily: tokens.font.mono,
  fontSize: "0.88em",
  padding: "1px 4px",
};

const linkStyle: CSSProperties = {
  color: tokens.color.accentBright,
  cursor: "pointer",
  textDecoration: "underline",
  textUnderlineOffset: "2px",
};

const iconButtonStyle: CSSProperties = {
  ...button("ghost", "sm"),
  color: tokens.color.ink.muted,
  height: "22px",
  padding: "0 6px",
};

const codeWrapStyle: CSSProperties = {
  position: "relative",
};

const codeCopyStyle: CSSProperties = {
  ...iconButtonStyle,
  position: "absolute",
  right: "6px",
  top: "6px",
};

/**
 * The folder a reply's file links resolve against: the session's. Without
 * one (`""`, as in the update dialog) nothing can open a file, so file paths
 * stay plain text and only URLs are links.
 */
export const LinkCwd = createContext("");

/**
 * A link in a reply: a URL opens in the browser, a file in its default app,
 * and Cmd/Ctrl+click reveals the file in Finder — the terminal's gestures. A
 * target that is neither (`mailto:`, `#anchor`) stays plain text.
 */
function Link({ children, target }: { children: ReactNode; target: string }) {
  const cwd = useContext(LinkCwd);
  const link = linkTarget(target);
  if (link === null || (link.kind === "path" && cwd === "")) {
    return <>{children}</>;
  }
  const href = link.kind === "url" ? link.url : link.path;
  return (
    <a
      className="kr-focusable"
      href={href}
      // The webview must never follow the href itself — not on a middle
      // click either.
      onAuxClick={(event) => event.preventDefault()}
      onClick={(event) => {
        event.preventDefault();
        openLinkTarget(cwd, link, event.metaKey || event.ctrlKey);
      }}
      style={linkStyle}
      title={href}
    >
      {children}
    </a>
  );
}

export function InlineText({ pieces }: { pieces: Inline[] }) {
  return (
    <>
      {pieces.map((piece, index) => {
        // Pieces never reorder; index is their identity.
        switch (piece.kind) {
          case "code":
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed list
              <code key={index} style={inlineCodeStyle}>
                {piece.text}
              </code>
            );
          case "bold":
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed list
              <strong key={index}>
                <InlineText pieces={piece.children} />
              </strong>
            );
          case "italic":
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed list
              <em key={index}>
                <InlineText pieces={piece.children} />
              </em>
            );
          case "link":
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed list
              <Link key={index} target={piece.target}>
                <InlineText pieces={piece.children} />
              </Link>
            );
          default:
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed list
            return <Fragment key={index}>{piece.text}</Fragment>;
        }
      })}
    </>
  );
}

/** A table block: scrolls sideways when wider than the reply. */
function Table({
  block,
  style,
}: {
  block: Extract<Block, { kind: "table" }>;
  style: CSSProperties;
}) {
  const aligned = (base: CSSProperties, at: number): CSSProperties => {
    const align: Align = block.align[at] ?? null;
    return align === null ? base : { ...base, textAlign: align };
  };
  return (
    <div style={tableWrapStyle}>
      <table style={style}>
        <thead>
          <tr>
            {block.head.map((cell, at) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed list
              <th key={at} style={aligned(headCellStyle, at)}>
                <InlineText pieces={cell} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed list
            <tr key={index}>
              {row.map((cell, at) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed list
                <td key={at} style={aligned(cellStyle, at)}>
                  <InlineText pieces={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The smaller text a dialog's Markdown (release notes) is set in. */
const SMALL: CSSProperties = { fontSize: "12.5px", lineHeight: 1.55 };

/**
 * Markdown drawn as elements (never as HTML): Claude's replies in the
 * [Structured view] at body `size`, release notes in the update dialog at
 * `small`.
 */
export function Markdown({
  size = "body",
  text,
}: {
  size?: "body" | "small";
  text: string;
}) {
  const sized = (style: CSSProperties) =>
    size === "small" ? { ...style, ...SMALL } : style;
  const blocks = parseReply(text);
  const drawn: ReactNode[] = blocks.map((block, index) => {
    switch (block.kind) {
      case "code":
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed list
          <div className="kr-copy-host" key={index} style={codeWrapStyle}>
            <pre style={codeBlockStyle}>
              <code>{block.text}</code>
            </pre>
            <CopyButton
              label="Copy code"
              style={codeCopyStyle}
              text={block.text}
            />
          </div>
        );
      case "heading":
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed list
          <p key={index} style={sized(headingStyle)}>
            <InlineText pieces={block.inline} />
          </p>
        );
      case "list": {
        const List = block.ordered ? "ol" : "ul";
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed list
          <List key={index} style={{ ...sized(listStyle), margin: 0 }}>
            {block.items.map((item, at) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed list
              <li key={at}>
                <InlineText pieces={item} />
              </li>
            ))}
          </List>
        );
      }
      case "rule":
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed list
        return <hr key={index} style={ruleStyle} />;
      case "table":
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed list
          <Table block={block} key={index} style={sized(tableStyle)} />
        );
      default:
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed list
          <p key={index} style={sized(replyStyle)}>
            <InlineText pieces={block.inline} />
          </p>
        );
    }
  });
  return <div style={replyBlocksStyle}>{drawn}</div>;
}

/** A small copy button; shows a tick for a moment after a copy. */
export function CopyButton({
  label,
  style = iconButtonStyle,
  text,
}: {
  label: string;
  style?: CSSProperties;
  text: string;
}) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) {
      return;
    }
    const timer = window.setTimeout(() => setDone(false), 1200);
    return () => window.clearTimeout(timer);
  }, [done]);
  return (
    <button
      aria-label={label}
      className="kr-focusable kr-hover-surface kr-copy"
      onClick={() => {
        copyText(text);
        setDone(true);
      }}
      style={style}
      title={label}
      type="button"
    >
      {done ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}
