import {
  Braces,
  ChevronRight,
  Code,
  Cog,
  Database,
  FileCode,
  FileText,
  FileType,
  Folder,
  FolderOpen,
  Hash,
  Image,
  Lock,
  Palette,
  Settings2,
  Terminal,
} from "lucide-react";
import type { CSSProperties } from "react";
import { tokens } from "../theme/tokens.ts";
import { langForPath } from "./highlighter.ts";

/**
 * A file's icon and its tint, keyed off the same language id `langForPath`
 * already produces for highlighting.
 *
 * Reusing that resolver rather than a second extension table is the point: a
 * file that highlights as YAML gets the YAML icon by construction, and adding
 * a language in one place can't leave the icon table behind. The tints come
 * from `tokens.color.syntax` for the same reason every other colour in this
 * view does — one palette, no literals outside the theme.
 *
 * Icons are lucide (already a dependency), not a ported editor icon theme:
 * those are hundreds of bespoke SVGs, and the job here is telling file kinds
 * apart at 14px in a 236px column, which a tinted glyph does.
 */
interface FileIconSpec {
  color: string;
  Icon: typeof FileCode;
}

const { syntax } = tokens.color;

/** Language id → icon + tint. Anything absent falls back to a plain document. */
const BY_LANG: Record<string, FileIconSpec> = {
  bash: { color: syntax.function, Icon: Terminal },
  c: { color: syntax.keyword, Icon: FileCode },
  cpp: { color: syntax.keyword, Icon: FileCode },
  csharp: { color: syntax.type, Icon: FileCode },
  css: { color: syntax.attribute, Icon: Palette },
  dockerfile: { color: syntax.keyword, Icon: Cog },
  go: { color: syntax.attribute, Icon: FileCode },
  graphql: { color: syntax.tag, Icon: Hash },
  hcl: { color: syntax.type, Icon: Cog },
  html: { color: syntax.string, Icon: Code },
  ini: { color: syntax.comment, Icon: Settings2 },
  java: { color: syntax.regexp, Icon: FileCode },
  javascript: { color: syntax.number, Icon: FileCode },
  json: { color: syntax.number, Icon: Braces },
  jsonc: { color: syntax.number, Icon: Braces },
  jsx: { color: syntax.constant, Icon: FileCode },
  kotlin: { color: syntax.keywordFlow, Icon: FileCode },
  lua: { color: syntax.keyword, Icon: FileCode },
  make: { color: syntax.comment, Icon: Cog },
  markdown: { color: syntax.variable, Icon: FileType },
  proto: { color: syntax.type, Icon: Hash },
  python: { color: syntax.number, Icon: FileCode },
  ruby: { color: syntax.regexp, Icon: FileCode },
  rust: { color: syntax.regexp, Icon: Cog },
  scss: { color: syntax.attribute, Icon: Palette },
  sql: { color: syntax.constant, Icon: Database },
  svelte: { color: syntax.regexp, Icon: Code },
  swift: { color: syntax.regexp, Icon: FileCode },
  toml: { color: syntax.comment, Icon: Settings2 },
  tsx: { color: syntax.constant, Icon: FileCode },
  typescript: { color: syntax.keyword, Icon: FileCode },
  vue: { color: syntax.function, Icon: Code },
  xml: { color: syntax.tag, Icon: Code },
  yaml: { color: syntax.comment, Icon: Settings2 },
};

/** Extensions with no language of their own that are still worth telling
 * apart — images and lockfiles read as neither code nor prose. */
const BY_EXT: Record<string, FileIconSpec> = {
  avif: { color: syntax.string, Icon: Image },
  gif: { color: syntax.string, Icon: Image },
  ico: { color: syntax.string, Icon: Image },
  jpeg: { color: syntax.string, Icon: Image },
  jpg: { color: syntax.string, Icon: Image },
  lock: { color: syntax.comment, Icon: Lock },
  png: { color: syntax.string, Icon: Image },
  webp: { color: syntax.string, Icon: Image },
};

const FALLBACK: FileIconSpec = {
  color: tokens.color.ink.dim,
  Icon: FileText,
};

/** The icon and tint for `path` — see {@link FileIconSpec}. */
export function fileIconSpec(path: string): FileIconSpec {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (name === "pnpm-lock.yaml" || name.endsWith(".lock")) {
    return BY_EXT.lock;
  }
  const dot = name.lastIndexOf(".");
  if (dot > 0) {
    const byExt = BY_EXT[name.slice(dot + 1)];
    if (byExt) {
      return byExt;
    }
  }
  return BY_LANG[langForPath(path)] ?? FALLBACK;
}

const iconStyle: CSSProperties = { flex: "none" };

/** One file's type icon, sized for a tree row or a header. */
export function FileIcon({ path, size = 14 }: { path: string; size?: number }) {
  const { Icon, color } = fileIconSpec(path);
  return (
    <Icon color={color} size={size} strokeWidth={1.75} style={iconStyle} />
  );
}

/** A directory's icon — open or closed, matching its disclosure state. */
export function DirIcon({ open, size = 14 }: { open: boolean; size?: number }) {
  const Icon = open ? FolderOpen : Folder;
  return (
    <Icon
      color={tokens.color.ink.dim}
      size={size}
      strokeWidth={1.75}
      style={iconStyle}
    />
  );
}

/** The disclosure chevron for a directory row, rotated when open. Its own
 * component so the rotation transition is defined once. */
export function DirChevron({
  open,
  size = 12,
}: {
  open: boolean;
  size?: number;
}) {
  return (
    <ChevronRight
      color={tokens.color.ink.faint}
      size={size}
      strokeWidth={2}
      style={{
        flex: "none",
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
        transition: `transform ${tokens.motion.disclose}`,
      }}
    />
  );
}
