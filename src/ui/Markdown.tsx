/**
 * Markdown as React elements, for Claude's replies and for release notes:
 * the slice `parseReply` reads, with links that open as the terminal's do.
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
import { type Inline, parseReply } from "../structured/replyMarkdown.ts";
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

/** The folder a reply's relative file links resolve against. */
export const LinkCwd = createContext("");

/**
 * A link in a reply: a URL opens in the browser, a file in its default app,
 * and Cmd/Ctrl+click reveals the file in Finder — the terminal's gestures. A
 * target that is neither (`mailto:`, `#anchor`) stays plain text.
 */
function Link({ children, target }: { children: ReactNode; target: string }) {
  const cwd = useContext(LinkCwd);
  const link = linkTarget(target);
  if (link === null) {
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
