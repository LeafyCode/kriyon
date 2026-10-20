import type { ToolActivity } from "../../types.ts";

/** Present-tense verb per common tool; falls back to the tool name itself. */
const VERB: Record<string, string> = {
  Bash: "Running",
  Edit: "Editing",
  Grep: "Searching",
  Read: "Reading",
  Write: "Writing",
};

/** Trailing slashes, stripped before taking a path's basename. */
const TRAILING_SLASHES = /\/+$/;

/** The basename of a path-like target, else the target unchanged. */
function basename(target: string): string {
  const trimmed = target.replace(TRAILING_SLASHES, "");
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

/** "Editing foo.tsx" / "Running" — a short label for an in-flight tool. */
export function toolLabel(tool: ToolActivity): string {
  const verb = VERB[tool.toolName];
  if (!verb) {
    return tool.toolName;
  }
  return tool.target ? `${verb} ${basename(tool.target)}` : verb;
}

/** Live "12s" / "1m 3s" elapsed from an ISO start to `nowMs`; "—" if unknown. */
export function elapsedLabel(fromIso: string | null, nowMs: number): string {
  if (!fromIso) {
    return "—";
  }
  const start = Date.parse(fromIso);
  if (Number.isNaN(start)) {
    return "—";
  }
  return spanLabel(Math.max(0, Math.round((nowMs - start) / 1000)));
}

/** "1.3s" / "2m 4s" — an exact, settled duration from milliseconds. */
export function durationLabel(ms: number): string {
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return spanLabel(Math.round(ms / 1000));
}

/** Whole-second span as "Ns" under a minute, else "Nm Ns". */
function spanLabel(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
}
