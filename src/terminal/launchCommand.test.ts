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
    expect(claudeLaunchCommand({ env: [], flags: "" }, null, false)).toBe(
      "claude\r"
    );
    expect(claudeLaunchCommand(nested, null, false)).toBe(
      "KRIYON_REPORT_TO=aaa KRIYON_REPORT_FROM=bbb claude --session-id bbb\r"
    );
  });

  it("reads a seed prompt from its file, removes it, and passes it", () => {
    expect(
      claudeLaunchCommand({ env: [], flags: "" }, "/r/s.prompt", false)
    ).toBe('p="$(cat "/r/s.prompt")"; rm -f "/r/s.prompt"; claude "$p"\r');
  });
});

describe("claudeLaunchCommand on PowerShell", () => {
  it("sets a nested session's env as statements", () => {
    expect(claudeLaunchCommand(nested, null, true)).toBe(
      "$env:KRIYON_REPORT_TO='aaa'; $env:KRIYON_REPORT_FROM='bbb'; claude --session-id bbb\r"
    );
  });

  it("reads a seed prompt from its file, removes it, and passes it", () => {
    const command = claudeLaunchCommand(
      { env: [], flags: "" },
      "C:\\Users\\O'Neil\\run\\s.prompt",
      true
    );
    expect(command).toContain(
      "Get-Content -Raw -LiteralPath 'C:\\Users\\O''Neil\\run\\s.prompt'"
    );
    expect(command).toContain(
      "Remove-Item -LiteralPath 'C:\\Users\\O''Neil\\run\\s.prompt'"
    );
    expect(command.endsWith("\r")).toBe(true);
    expect(command).toContain("claude ");
  });
});
