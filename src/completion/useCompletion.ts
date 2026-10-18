import { useEffect, useMemo, useRef, useState } from "react";
import { type FileEntry, listFiles } from "../ipc/bridge.ts";
import { useCompletions } from "../state/completions.ts";
import type { CompletionRow } from "./CompletionPopover.tsx";
import { detectTrigger } from "./detect.ts";
import { fuzzyFilter } from "./filter.ts";

/** An accepted completion: replace [start,end) in the draft with `insert`. */
export interface CompletionItem {
  end: number;
  insert: string;
  start: number;
}

export interface CompletionView {
  activeIndex: number;
  degraded: boolean;
  header: string;
  items: CompletionItem[];
  kind: "slash" | "mention" | null;
  mode: "bash" | "memory" | null;
  open: boolean;
  rows: CompletionRow[];
}

/**
 * Above ordinary inter-keystroke time (~150-250ms), so a burst of typing
 * coalesces into one backend walk. At 120ms it sat *below* typing speed, which
 * meant every character and every backspace fired its own full directory walk —
 * a debounce that never actually debounced.
 */
const DEBOUNCE_MS = 220;

/**
 * Most rows the popover will render. An empty query matches the whole catalog,
 * so a bare `/` used to render every command on disk (344 here) — each row
 * measuring an ellipsized description that can run to a thousand-plus
 * characters. Nobody scrolls a 344-row popover to find a command; they type
 * another letter. The list is ranked, so the cut is off the useless tail.
 */
const MAX_ROWS = 40;

/**
 * Drive the composer's completion popover from the current draft + caret. Slash
 * rows come from the cached catalog (sync); `@` file rows are fetched
 * (debounced) from the backend and merged with matching agent names. `!`/`#`
 * surface as a `mode` for the caller's hint chip without opening a popover.
 */
export function useCompletion(args: {
  cwd: string | null;
  value: string;
  caret: number;
  /** A tag for a slash command the caller answers itself, by `/name`. */
  tagFor?: (command: string) => string | undefined;
}): {
  view: CompletionView;
  move: (delta: number) => void;
  reset: () => void;
  itemAt: (index: number) => CompletionItem | undefined;
} {
  const { cwd, value, caret, tagFor } = args;
  const trigger = useMemo(() => detectTrigger(value, caret), [value, caret]);
  const catalog = useCompletions((s) => (cwd ? s.byCwd[cwd] : undefined));
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [closed, setClosed] = useState(false);

  // Self-warm the slash-command cache for this cwd. `createSession` already
  // warms on session creation, but resumed/rehydrated sessions never call it —
  // this covers every case and makes that call a harmless pre-warm. `warmup`
  // guards on an existing cache entry or an in-flight load, so this is a no-op
  // once the catalog is cached.
  useEffect(() => {
    if (cwd) {
      useCompletions.getState().warmup(cwd);
    }
  }, [cwd]);

  // Fetch files for a mention query (debounced). Reset when the query changes.
  const mentionQuery = trigger?.kind === "mention" ? trigger.query : null;
  const seq = useRef(0);
  useEffect(() => {
    if (mentionQuery === null || !cwd) {
      setFiles([]);
      return;
    }
    seq.current += 1;
    const mine = seq.current;
    const t = setTimeout(() => {
      listFiles(cwd, mentionQuery)
        .then((res) => {
          if (seq.current === mine) {
            setFiles(res);
          }
        })
        .catch(() => {
          if (seq.current === mine) {
            setFiles([]);
          }
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [mentionQuery, cwd]);

  // Any change to the trigger reopens and resets the selection.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are reset triggers, not values read in the body
  useEffect(() => {
    setActiveIndex(0);
    setClosed(false);
  }, [
    trigger?.kind,
    mentionQuery,
    trigger?.kind === "slash" ? trigger.query : null,
  ]);

  const view = useMemo<CompletionView>(() => {
    const empty: CompletionView = {
      open: false,
      kind: null,
      mode: null,
      rows: [],
      items: [],
      activeIndex: 0,
      degraded: catalog?.degraded ?? false,
      header: "",
    };
    if (closed || !trigger) {
      return empty;
    }
    if (trigger.kind === "mode") {
      return { ...empty, mode: trigger.mode };
    }
    if (trigger.kind === "slash") {
      const commands = catalog?.commands ?? [];
      const matched = fuzzyFilter(commands, trigger.query, (c) => c.name).slice(
        0,
        MAX_ROWS
      );
      const rows: CompletionRow[] = matched.map((c) => ({
        primary: `/${c.name}`,
        secondary: c.description ?? undefined,
        hint: c.argumentHint ?? undefined,
        tag: tagFor?.(`/${c.name}`),
      }));
      const items: CompletionItem[] = matched.map((c) => ({
        insert: `/${c.name} `,
        start: trigger.start,
        end: trigger.end,
      }));
      return {
        ...empty,
        open: rows.length > 0,
        kind: "slash",
        rows,
        items,
        activeIndex,
        header: "Commands",
      };
    }
    // mention: agents first (matching the query), then files.
    const agents = (catalog?.agents ?? []).filter((a) =>
      a.toLowerCase().includes(trigger.query.toLowerCase())
    );
    const agentRows: CompletionRow[] = agents.map((a) => ({
      primary: `@agent-${a}`,
      secondary: "subagent",
    }));
    const agentItems: CompletionItem[] = agents.map((a) => ({
      insert: `@agent-${a} `,
      start: trigger.start,
      end: trigger.end,
    }));
    const fileRows: CompletionRow[] = files.map((f) => ({
      primary: `@${f.path}`,
      secondary: f.isDir ? "dir" : undefined,
    }));
    const fileItems: CompletionItem[] = files.map((f) => ({
      insert: `@${f.path} `,
      start: trigger.start,
      end: trigger.end,
    }));
    // Agents keep their places, files fill whatever is left (the backend
    // already caps files, but the two lists are only bounded once combined).
    const rows = [...agentRows, ...fileRows].slice(0, MAX_ROWS);
    const items = [...agentItems, ...fileItems].slice(0, MAX_ROWS);
    return {
      ...empty,
      open: rows.length > 0,
      kind: "mention",
      rows,
      items,
      activeIndex,
      header: "Mentions",
    };
  }, [trigger, catalog, files, activeIndex, closed, tagFor]);

  return {
    view,
    move: (delta) => {
      const n = view.rows.length;
      if (n > 0) {
        setActiveIndex((i) => (i + delta + n) % n);
      }
    },
    reset: () => setClosed(true),
    itemAt: (index) => view.items[index],
  };
}
