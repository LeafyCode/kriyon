import type { ShellLanguage } from "../types.ts";

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
const PS_ESCAPED_ARG =
  "(($p.TrimEnd(\"`r`n\") -replace '(\\\\*)\"', '$1$1\\\"') -replace '(\\\\+)$', '$1$1')";

/**
 * The seed as `claude`'s argument. pwsh 7.3+ (a Mac or Linux user's `$SHELL`
 * can be pwsh) escapes a native argument's quotes itself, which
 * `$PSNativeCommandArgumentPassing` reports as `Standard`; escaping them again
 * would hand claude a literal backslash. Windows PowerShell 5.1, which Kriyon
 * hosts on Windows, has no such variable, so it gets {@link PS_ESCAPED_ARG}.
 */
const PS_NATIVE_ARG = `$(if ($PSNativeCommandArgumentPassing -in $null, 'Legacy') { ${PS_ESCAPED_ARG} } else { $p.TrimEnd("\`r\`n") })`;

/**
 * The line typed into a fresh session's shell to start `claude`, ending in a
 * carriage return. `seedPath`, when given, is a Kriyon-written file holding the
 * first prompt: the line reads it, removes it, and passes it as `claude`'s
 * argument, so no user text is ever typed into the shell.
 *
 * `shell` is the language of the session's shell, as Rust reported it when the
 * session opened.
 */
export function claudeLaunchCommand(
  launch: ClaudeLaunch,
  seedPath: string | null,
  shell: ShellLanguage
): string {
  if (shell === "powerShell") {
    return powerShellLaunch(launch, seedPath);
  }
  const env = launch.env.map(([name, value]) => `${name}=${value} `).join("");
  if (seedPath === null) {
    return `${env}claude${launch.flags}\r`;
  }
  return `p="$(cat "${seedPath}")"; rm -f "${seedPath}"; ${env}claude${launch.flags} "$p"\r`;
}

/**
 * {@link claudeLaunchCommand} for PowerShell. A `$env:` assignment lasts for
 * the whole shell, not one command as `NAME=value claude` does in sh, so the
 * variables are removed again when `claude` ends — even on Ctrl-C — and a
 * `claude` started later in the same terminal doesn't inherit them. The seed
 * file is read as UTF-8: Kriyon writes it without a BOM, which Windows
 * PowerShell would otherwise read in the legacy code page.
 */
function powerShellLaunch(
  launch: ClaudeLaunch,
  seedPath: string | null
): string {
  const read =
    seedPath === null
      ? ""
      : `$p = Get-Content -Raw -Encoding UTF8 -LiteralPath ${psQuote(seedPath)}; Remove-Item -LiteralPath ${psQuote(seedPath)}; `;
  const claude = `claude${launch.flags}${seedPath === null ? "" : ` ${PS_NATIVE_ARG}`}`;
  if (launch.env.length === 0) {
    return `${read}${claude}\r`;
  }
  const set = launch.env
    .map(([name, value]) => `$env:${name}=${psQuote(value)}; `)
    .join("");
  const unset = launch.env.map(([name]) => `Env:${name}`).join(", ");
  return `${read}${set}try { ${claude} } finally { Remove-Item ${unset} -ErrorAction Ignore }\r`;
}
