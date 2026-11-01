/** What a `claude` launch adds: env for a [Nested session], and its flags. */
export interface ClaudeLaunch {
  /** Variables the launched `claude` starts with, as `[name, value]`. */
  env: [string, string][];
  /** Flags after `claude`, each with its leading space (`" --session-id x"`). */
  flags: string;
}

/** A value inside PowerShell single quotes, where only `'` needs doubling. */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Windows PowerShell 5.1 passes a native program's argument without escaping
 * the double quotes inside it, so a prompt with a `"` would arrive split. This
 * is the expression that escapes them the way the program's argument parser
 * reads them: a `"` becomes `\"` (with any backslashes before it doubled), and
 * backslashes ending the prompt are doubled so they can't escape the closing
 * quote PowerShell adds.
 */
const PS_NATIVE_ARG =
  "(($p.TrimEnd(\"`r`n\") -replace '(\\\\*)\"', '$1$1\\\"') -replace '(\\\\+)$', '$1$1')";

/**
 * The line typed into a fresh session's shell to start `claude`, ending in a
 * carriage return. `seedPath`, when given, is a Kriyon-written file holding the
 * first prompt: the line reads it, removes it, and passes it as `claude`'s
 * argument, so no user text is ever typed into the shell.
 *
 * `windows` picks the session shell's language: PowerShell there, POSIX sh
 * everywhere else.
 */
export function claudeLaunchCommand(
  launch: ClaudeLaunch,
  seedPath: string | null,
  windows: boolean
): string {
  if (windows) {
    const env = launch.env
      .map(([name, value]) => `$env:${name}=${psQuote(value)}; `)
      .join("");
    if (seedPath === null) {
      return `${env}claude${launch.flags}\r`;
    }
    const path = psQuote(seedPath);
    return `$p = Get-Content -Raw -LiteralPath ${path}; Remove-Item -LiteralPath ${path}; ${env}claude${launch.flags} ${PS_NATIVE_ARG}\r`;
  }
  const env = launch.env.map(([name, value]) => `${name}=${value} `).join("");
  if (seedPath === null) {
    return `${env}claude${launch.flags}\r`;
  }
  return `p="$(cat "${seedPath}")"; rm -f "${seedPath}"; ${env}claude${launch.flags} "$p"\r`;
}
