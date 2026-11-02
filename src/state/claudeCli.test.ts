import { beforeEach, expect, test, vi } from "vitest";
import { findClaudeCli } from "../ipc/bridge.ts";
import { needsClaudeInstall, useClaudeCli } from "./claudeCli.ts";

vi.mock("../ipc/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/bridge.ts")>()),
  findClaudeCli: vi.fn(),
}));

beforeEach(() => {
  useClaudeCli.setState({ checking: false, result: null, skipped: false });
});

test("asks for an install only once the check has found no claude", async () => {
  expect(needsClaudeInstall(useClaudeCli.getState())).toBe(false);
  vi.mocked(findClaudeCli).mockResolvedValue({ state: "missing" });
  await useClaudeCli.getState().check();
  expect(needsClaudeInstall(useClaudeCli.getState())).toBe(true);
});

test("a found claude, or a PATH that couldn't be read, needs no install", async () => {
  vi.mocked(findClaudeCli).mockResolvedValue({
    path: "/Users/me/.local/bin/claude",
    state: "found",
  });
  await useClaudeCli.getState().check();
  expect(needsClaudeInstall(useClaudeCli.getState())).toBe(false);
  vi.mocked(findClaudeCli).mockResolvedValue({ state: "unknown" });
  await useClaudeCli.getState().check();
  expect(needsClaudeInstall(useClaudeCli.getState())).toBe(false);
});

test("a failed check is unknown, not missing", async () => {
  vi.mocked(findClaudeCli).mockRejectedValue(new Error("no runtime"));
  await useClaudeCli.getState().check();
  expect(useClaudeCli.getState().result).toEqual({ state: "unknown" });
});

test("continue anyway hides the install screen for this run", async () => {
  vi.mocked(findClaudeCli).mockResolvedValue({ state: "missing" });
  await useClaudeCli.getState().check();
  useClaudeCli.getState().skip();
  expect(needsClaudeInstall(useClaudeCli.getState())).toBe(false);
});
