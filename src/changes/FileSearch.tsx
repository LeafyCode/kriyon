import { Search, X } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { type FileEntry, findFiles } from "../ipc/bridge.ts";
import { failureMessage } from "../ipc/failures.ts";
import type { TreeDecorations } from "../state/changesView.ts";
import { matchRange } from "../state/fileSearch.ts";
import { iconButton, inputBox, treeRow } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import { DirIcon, FileIcon } from "./fileIcon.tsx";

/** How long typing must pause before the project is searched. Each search
 * walks the tree on the Rust side, so not one per keystroke. */
const SEARCH_DEBOUNCE_MS = 120;

const boxRowStyle: CSSProperties = {
  flex: "none",
  padding: "0 8px 6px",
};

const boxStyle: CSSProperties = {
  ...inputBox(),
  display: "flex",
  gap: "6px",
  height: "26px",
  padding: "0 4px 0 8px",
};

const inputStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  color: tokens.color.ink.primary,
  flex: 1,
  fontFamily: tokens.font.sans,
  fontSize: "12.5px",
  minWidth: 0,
  outline: "none",
  padding: 0,
};

const clearButtonStyle: CSSProperties = {
  ...iconButton(),
  height: "18px",
  width: "18px",
};

const resultsStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: "0 4px 6px",
};

const nameStyle: CSSProperties = {
  flex: "none",
  maxWidth: "70%",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const dirStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  flex: 1,
  fontSize: "11.5px",
  marginLeft: "6px",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const highlightStyle: CSSProperties = {
  color: tokens.color.accentBright,
  fontWeight: 600,
};

const iconSlotStyle: CSSProperties = {
  display: "flex",
  flex: "none",
  marginRight: "6px",
};

const noteStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontFamily: tokens.font.sans,
  fontSize: "12px",
  padding: "4px 10px",
};

const errorStyle: CSSProperties = {
  ...noteStyle,
  color: tokens.color.status.error,
};

/** What the results list shows, for one query. */
type SearchState =
  | { status: "idle" }
  | { status: "loading" }
  | { message: string; status: "error" }
  | {
      entries: FileEntry[];
      /** The query these entries answer — the box may have moved on. */
      query: string;
      status: "done";
      truncated: boolean;
    };

function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf("/");
  return slash === -1
    ? { dir: "", name: path }
    : { dir: path.slice(0, slash), name: path.slice(slash + 1) };
}

/** The name, with the part that matched the query lit. */
function HighlightedName({ name, query }: { name: string; query: string }) {
  const range = matchRange(name, query);
  if (!range) {
    return <>{name}</>;
  }
  const [start, end] = range;
  return (
    <>
      {name.slice(0, start)}
      <span style={highlightStyle}>{name.slice(start, end)}</span>
      {name.slice(end)}
    </>
  );
}

/** Up/down through the results, and up from the first back to the box. */
function moveInResults(
  event: KeyboardEvent<HTMLElement>,
  input: HTMLInputElement | null
): void {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
    return;
  }
  const rows = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>("[data-row-path]")
  );
  const at = rows.indexOf(event.target as HTMLElement);
  const next = event.key === "ArrowDown" ? rows[at + 1] : rows[at - 1];
  if (next) {
    next.focus();
  } else if (event.key === "ArrowUp") {
    input?.focus();
  }
  event.preventDefault();
}

/**
 * The Files view's search box: finds a file anywhere in the project by name,
 * the way an editor's quick-open does, without the user having to open the
 * folders it lives in first.
 *
 * The tree only knows the folders it has opened, so filtering it would miss
 * most of the project. This asks the backend's `findFiles` instead — the same
 * .gitignore-respecting walk the `@`-mention picker uses, ranked by name over
 * every match before the result cut.
 *
 * While a query is typed the results take the tree's place (`children` is
 * the tree); opening a result clears the search and hands the entry to
 * `onOpen`, so the tree comes back showing it.
 */
export function FileSearch({
  children,
  cwd,
  decorations,
  onOpen,
}: {
  children: ReactNode;
  cwd: string;
  decorations: TreeDecorations;
  onOpen: (entry: FileEntry) => void;
}) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<SearchState>({ status: "idle" });
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Bumped per search, so an answer for a query the user has typed past is
  // dropped rather than painted over the newer one.
  const requestRef = useRef(0);
  const trimmed = query.trim();
  // Enter pressed while the answer for what is typed hasn't landed yet:
  // open that answer's top match when it does, never the previous query's.
  const openOnArrivalRef = useRef(false);

  // A search belongs to the folder it was typed in.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `cwd` is the reset trigger, not a value the body reads.
  useEffect(() => {
    setQuery("");
  }, [cwd]);

  useEffect(() => {
    requestRef.current += 1;
    const request = requestRef.current;
    if (trimmed === "") {
      setState({ status: "idle" });
      return;
    }
    setState((prev) => (prev.status === "done" ? prev : { status: "loading" }));
    const timer = setTimeout(() => {
      findFiles(cwd, trimmed)
        .then((found) => {
          if (requestRef.current !== request) {
            return;
          }
          const [first] = found.entries;
          if (openOnArrivalRef.current && first) {
            openOnArrivalRef.current = false;
            setQuery("");
            onOpenRef.current(first);
            return;
          }
          openOnArrivalRef.current = false;
          setState({
            entries: found.entries,
            query: trimmed,
            status: "done",
            truncated: found.truncated,
          });
        })
        .catch((error: unknown) => {
          if (requestRef.current === request) {
            setState({ message: failureMessage(error), status: "error" });
          }
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [cwd, trimmed]);

  // The latest `onOpen`, read by the fetch's late callback.
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  function open(entry: FileEntry): void {
    setQuery("");
    onOpen(entry);
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape") {
      if (query === "") {
        event.currentTarget.blur();
      }
      setQuery("");
      openOnArrivalRef.current = false;
      event.preventDefault();
    } else if (event.key === "Enter" && trimmed !== "") {
      const current = state.status === "done" && state.query === trimmed;
      const [first] = current ? state.entries : [];
      if (first) {
        open(first);
      } else if (!current) {
        openOnArrivalRef.current = true;
      }
      event.preventDefault();
    } else if (event.key === "ArrowDown") {
      event.currentTarget
        .closest("[data-file-search]")
        ?.querySelector<HTMLElement>("[data-row-path]")
        ?.focus();
      event.preventDefault();
    }
  }

  return (
    <div data-file-search style={{ display: "contents" }}>
      <div style={boxRowStyle}>
        <div style={boxStyle}>
          <Search
            aria-hidden
            color={tokens.color.ink.faint}
            size={13}
            strokeWidth={2}
            style={{ flex: "none" }}
          />
          <input
            aria-label="Search files"
            onChange={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search files"
            ref={inputRef}
            spellCheck={false}
            style={inputStyle}
            type="search"
            value={query}
          />
          {query === "" ? null : (
            <button
              aria-label="Clear search"
              className="kr-hover-surface"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              style={clearButtonStyle}
              title="Clear search"
              type="button"
            >
              <X size={12} strokeWidth={2} />
            </button>
          )}
        </div>
      </div>
      {trimmed === "" ? (
        children
      ) : (
        // biome-ignore lint/a11y/noStaticElementInteractions: the arrow keys bubble up from the result buttons; the list is not a control of its own.
        // biome-ignore lint/a11y/noNoninteractiveElementInteractions: same — the rows are the controls.
        <div
          data-testid="file-search-results"
          onKeyDown={(e) => moveInResults(e, inputRef.current)}
          style={resultsStyle}
        >
          <SearchResults
            decorations={decorations}
            onOpen={open}
            state={state}
          />
        </div>
      )}
    </div>
  );
}

function SearchResults({
  decorations,
  onOpen,
  state,
}: {
  decorations: TreeDecorations;
  onOpen: (entry: FileEntry) => void;
  state: SearchState;
}) {
  if (state.status === "error") {
    return <div style={errorStyle}>{state.message}</div>;
  }
  if (state.status !== "done") {
    return <div style={noteStyle}>Searching…</div>;
  }
  if (state.entries.length === 0) {
    return <div style={noteStyle}>No files match.</div>;
  }
  return (
    <>
      {state.entries.map((entry) => {
        const { dir, name } = splitPath(entry.path);
        const change = decorations.files.get(entry.path);
        return (
          <button
            className="kr-hover-surface kr-tree-row"
            data-git={change}
            data-row-path={entry.path}
            data-testid="file-search-result"
            key={entry.path}
            onClick={() => onOpen(entry)}
            style={treeRow()}
            title={entry.path}
            type="button"
          >
            <span style={iconSlotStyle}>
              {entry.isDir ? (
                <DirIcon open={false} />
              ) : (
                <FileIcon path={entry.path} />
              )}
            </span>
            <span style={nameStyle}>
              <HighlightedName name={name} query={state.query} />
            </span>
            {dir ? <span style={dirStyle}>{dir}</span> : null}
          </button>
        );
      })}
      {state.truncated ? (
        <div style={noteStyle}>
          More files match. Keep typing to narrow it down.
        </div>
      ) : null}
    </>
  );
}
