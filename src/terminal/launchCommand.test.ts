import { describe, expect, it } from "vitest";
import { claudeLaunchCommand } from "./launchCommand.ts";

const nested = {
  env: [
    ["KRIYON_REPORT_TO", "aaa"],
    ["KRIYON_REPORT_FROM", "bbb"],
  ] as [string, string][],
  flags: " --session-id bbb",
};

describe("claudeLaunchCommand on a POSIX shell", () => {
  it("starts claude, with a nested session's env prefixed", () => {
    expect(claudeLaunchCommand({ env: [], flags: "" }, null, "posix")).toBe(
      "claude\r"
    );
    expect(claudeLaunchCommand(nested, null, "posix")).toBe(
      "KRIYON_REPORT_TO=aaa KRIYON_REPORT_FROM=bbb claude --session-id bbb\r"
    );
  });

  it("reads a seed prompt from its file, removes it, and passes it", () => {
    expect(
      claudeLaunchCommand({ env: [], flags: "" }, "/r/s.prompt", "posix")
    ).toBe('p="$(cat "/r/s.prompt")"; rm -f "/r/s.prompt"; claude "$p"\r');
  });
});

/** The expression that escapes the seed for a native argument (see launchCommand.ts). */
const PS_ESCAPED =
  "(($p.TrimEnd(\"`r`n\") -replace '(\\\\*)\"', '$1$1\\\"') -replace '(\\\\+)$', '$1$1')";

/** The seed argument: escaped only where PowerShell passes quotes raw. */
const PS_ARG = `$(if ($PSNativeCommandArgumentPassing -in $null, 'Legacy') { ${PS_ESCAPED} } else { $p.TrimEnd("\`r\`n") })`;

/** The PowerShell -replace steps of PS_ARG, run as JavaScript: the patterns
 * read the same in .NET and JavaScript, so the rule itself is checked. */
const TRAILING_NEWLINES = /[\r\n]+$/;
const QUOTE_WITH_BACKSLASHES = /(\\*)"/g;
const TRAILING_BACKSLASHES = /(\\+)$/;
function psEscape(prompt: string): string {
  return prompt
    .replace(TRAILING_NEWLINES, "")
    .replace(QUOTE_WITH_BACKSLASHES, '$1$1\\"')
    .replace(TRAILING_BACKSLASHES, "$1$1");
}

describe("claudeLaunchCommand on PowerShell", () => {
  it("starts claude bare when there is nothing to set", () => {
    expect(
      claudeLaunchCommand({ env: [], flags: "" }, null, "powerShell")
    ).toBe("claude\r");
  });

  it("sets a nested session's env only for that claude, and removes it after", () => {
    expect(claudeLaunchCommand(nested, null, "powerShell")).toBe(
      "$env:KRIYON_REPORT_TO='aaa'; $env:KRIYON_REPORT_FROM='bbb'; " +
        "try { claude --session-id bbb } finally { Remove-Item Env:KRIYON_REPORT_TO, Env:KRIYON_REPORT_FROM -ErrorAction Ignore }\r"
    );
  });

  it("reads a seed prompt as UTF-8, removes the file, and passes it escaped", () => {
    expect(
      claudeLaunchCommand(
        { env: [], flags: "" },
        "C:\\Users\\O'Neil\\run\\s.prompt",
        "powerShell"
      )
    ).toBe(
      "$p = Get-Content -Raw -Encoding UTF8 -LiteralPath 'C:\\Users\\O''Neil\\run\\s.prompt'; " +
        "Remove-Item -LiteralPath 'C:\\Users\\O''Neil\\run\\s.prompt'; " +
        `claude ${PS_ARG}\r`
    );
  });

  it("escapes the seed's quotes and trailing backslashes the way claude's parser reads them", () => {
    expect(PS_ESCAPED).toContain(String.raw`-replace '(\\*)"', '$1$1\"'`);
    expect(PS_ESCAPED).toContain(String.raw`-replace '(\\+)$', '$1$1'`);
    expect(psEscape('say "hi"\r\n')).toBe('say \\"hi\\"');
    expect(psEscape('a\\"b')).toBe('a\\\\\\"b');
    expect(psEscape("C:\\dir\\")).toBe("C:\\dir\\\\");
  });

  // pwsh 7.3+ (a Mac user's $SHELL can be pwsh) escapes a native argument's
  // quotes itself ($PSNativeCommandArgumentPassing = Standard), so escaping
  // them again would hand claude a literal backslash. Windows PowerShell 5.1,
  // which Kriyon hosts on Windows, has no such variable and passes them raw.
  it("escapes the seed only when PowerShell passes quotes raw", () => {
    const command = claudeLaunchCommand(
      { env: [], flags: "" },
      "/tmp/s.prompt",
      "powerShell"
    );
    expect(command).toContain(
      "$(if ($PSNativeCommandArgumentPassing -in $null, 'Legacy') { "
    );
    expect(command).toContain(`} else { $p.TrimEnd("\`r\`n") })\r`);
  });

  it("scopes the env around a seeded launch too", () => {
    const command = claudeLaunchCommand(
      nested,
      "C:\\r\\s.prompt",
      "powerShell"
    );
    expect(command).toContain(
      `try { claude --session-id bbb ${PS_ARG} } finally { Remove-Item Env:KRIYON_REPORT_TO, Env:KRIYON_REPORT_FROM -ErrorAction Ignore }\r`
    );
  });
});
