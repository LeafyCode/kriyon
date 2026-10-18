import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/bridge.ts", () => ({
  listSlashCommands: vi.fn(),
}));

import { listSlashCommands } from "../ipc/bridge.ts";
import { useCompletions } from "./completions.ts";

const catalog = {
  commands: [],
  agents: [],
  claudeVersion: "2.1.202",
  degraded: false,
};

describe("useCompletions", () => {
  beforeEach(() => {
    useCompletions.setState({ byCwd: {}, loading: {} });
    vi.mocked(listSlashCommands).mockReset().mockResolvedValue(catalog);
  });

  it("warmup fetches once and caches", async () => {
    await useCompletions.getState().warmup("/repo");
    await useCompletions.getState().warmup("/repo");
    expect(listSlashCommands).toHaveBeenCalledTimes(1);
    expect(useCompletions.getState().catalogFor("/repo")).toEqual(catalog);
  });

  it("refresh re-fetches even when cached", async () => {
    await useCompletions.getState().warmup("/repo");
    await useCompletions.getState().refresh("/repo");
    expect(listSlashCommands).toHaveBeenCalledTimes(2);
  });

  it("a failed warmup does not throw and leaves no cache entry", async () => {
    vi.mocked(listSlashCommands).mockRejectedValueOnce(new Error("no claude"));
    await useCompletions.getState().warmup("/repo");
    expect(useCompletions.getState().catalogFor("/repo")).toBeUndefined();
  });

  it("dedups a second warmup while the first is still in flight", async () => {
    let resolve!: (value: typeof catalog) => void;
    vi.mocked(listSlashCommands)
      .mockReset()
      .mockReturnValueOnce(
        new Promise((r) => {
          resolve = r;
        })
      );
    // The first warmup flips `loading` synchronously before awaiting, so the
    // second sees it in flight and issues no second fetch.
    const first = useCompletions.getState().warmup("/repo");
    const second = useCompletions.getState().warmup("/repo");
    resolve(catalog);
    await Promise.all([first, second]);
    expect(listSlashCommands).toHaveBeenCalledTimes(1);
  });
});
