// CI for a pull request's head commit, as `gh pr checks` reports it.

import { execFileSync } from "node:child_process";

/**
 * `[{ name, bucket }]`, `[]` when the repo runs no checks, or `null` when the
 * status could not be read.
 *
 * `gh pr checks` exits non-zero while a check fails or is still running, so
 * the JSON is read from the error as well. A null is never "green".
 */
export function readChecks(prNumber) {
  try {
    const out = execFileSync(
      "gh",
      ["pr", "checks", String(prNumber), "--json", "name,bucket"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    return JSON.parse(out || "[]");
  } catch (error) {
    if (String(error.stderr ?? "").includes("no checks reported")) {
      return [];
    }
    try {
      return JSON.parse(error.stdout || "null");
    } catch {
      return null;
    }
  }
}
