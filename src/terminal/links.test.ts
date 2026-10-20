import { describe, expect, it, test, vi } from "vitest";
import { useOutsideOpen } from "../state/outsideOpen.ts";

const openPath = vi.fn((_cwd: string, _path: string, _allowOutside?: boolean) =>
  Promise.resolve()
);
const revealPath = vi.fn((_cwd: string, _path: string) => Promise.resolve());
const openExternalUrl = vi.fn((_url: string) => Promise.resolve());
const showToast = vi.fn();
vi.mock("../ui/Toast.tsx", () => ({
  showToast: (message: string, kind: string) => showToast(message, kind),
}));
vi.mock("../ipc/bridge.ts", () => ({
  openExternalUrl: (url: string) => openExternalUrl(url),
  openPath: (cwd: string, path: string, allowOutside?: boolean) =>
    allowOutside === undefined
      ? openPath(cwd, path)
      : openPath(cwd, path, allowOutside),
  revealPath: (cwd: string, path: string) => revealPath(cwd, path),
}));

import {
  findLinks,
  isUrl,
  linkTarget,
  looksLikePath,
  matchPaths,
  openExternalLink,
  openFileToken,
  stripLineSuffix,
} from "./links.ts";

describe("stripLineSuffix", () => {
  it("strips a trailing :line and :line:col of ascii digits", () => {
    expect(stripLineSuffix("src/foo.ts:42")).toBe("src/foo.ts");
    expect(stripLineSuffix("src/foo.ts:42:7")).toBe("src/foo.ts");
  });
  it("leaves a non-numeric trailing segment alone (mirrors core links.rs)", () => {
    // The old `split(":")[0]` mangled this to "a"; a real path token keeps it.
    expect(stripLineSuffix("a:b")).toBe("a:b");
    expect(stripLineSuffix("src/foo.ts")).toBe("src/foo.ts");
  });
  it("strips a leading-colon line suffix like the Rust core does", () => {
    // Rust rsplit_once(':') strips ":42" to ""; mirror it so a path the frontend
    // passes resolves the same on both sides of the IPC boundary.
    expect(stripLineSuffix(":42")).toBe("");
  });
});

describe("looksLikePath", () => {
  it("accepts pathish backtick contents", () => {
    expect(looksLikePath("src/foo.ts")).toBe(true);
    expect(looksLikePath("report.pdf")).toBe(true);
    expect(looksLikePath("src/foo.ts:42")).toBe(true);
  });
  it("rejects prose and code that is not a path", () => {
    expect(looksLikePath("useEffect")).toBe(false);
    expect(looksLikePath("const x = 1")).toBe(false);
    expect(looksLikePath("a:b")).toBe(false);
  });
  it("rejects a URL (it has a slash but is not a file path)", () => {
    // A backtick-wrapped URL must not read as a path, or it renders as a
    // FileLink whose click resolves to cwd/https:/… and dead-ends.
    expect(looksLikePath("https://example.com/docs")).toBe(false);
    expect(looksLikePath("http://x.y/z.html")).toBe(false);
  });
});

describe("matchPaths", () => {
  it("finds a path token with its char offsets inside surrounding text", () => {
    const line = "see src/foo.rs:42 for the fix";
    const matches = matchPaths(line);
    expect(matches).toHaveLength(1);
    const [m] = matches;
    expect(m.token).toBe("src/foo.rs:42");
    expect(line.slice(m.start, m.end)).toBe("src/foo.rs:42");
  });
  it("matches ~ and ./ prefixes and ignores plain words", () => {
    expect(matchPaths("~/notes/a.md").map((m) => m.token)).toEqual([
      "~/notes/a.md",
    ]);
    expect(
      matchPaths("./build/out.js and ../x/y.ts").map((m) => m.token)
    ).toEqual(["./build/out.js", "../x/y.ts"]);
    expect(matchPaths("just some prose here")).toEqual([]);
  });
  it("keeps the leading slash of an absolute path", () => {
    // Without it `/Users/me/a.ts` matched as `Users/me/a.ts`, which resolves
    // against cwd and opens nothing.
    expect(matchPaths("wrote /Users/me/a.ts:3").map((m) => m.token)).toEqual([
      "/Users/me/a.ts:3",
    ]);
  });
  it("is not stateful across calls (global regex reuse is safe)", () => {
    const line = "a/b.ts c/d.ts";
    expect(matchPaths(line)).toHaveLength(2);
    expect(matchPaths(line)).toHaveLength(2);
  });
});

describe("isUrl", () => {
  it("detects http(s) chunks", () => {
    expect(isUrl("https://example.com")).toBe(true);
    expect(isUrl("http://x.y")).toBe(true);
    expect(isUrl("not a url")).toBe(false);
    expect(isUrl("`code`")).toBe(false);
  });
});

describe("dispatch helpers", () => {
  it("openFileToken opens by default and reveals on the modifier", () => {
    openFileToken("/proj", "src/a.ts", false);
    expect(openPath).toHaveBeenCalledWith("/proj", "src/a.ts");
    openFileToken("/proj", "src/a.ts", true);
    expect(revealPath).toHaveBeenCalledWith("/proj", "src/a.ts");
  });
  it("says why when a file won't open, instead of doing nothing", async () => {
    openPath.mockRejectedValueOnce("path does not exist");
    openFileToken("/proj", "src/gone.ts", false);
    await vi.waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(
        "Couldn't open src/gone.ts: path does not exist",
        "error"
      );
    });
  });
  it("says so when a URL won't open", async () => {
    openExternalUrl.mockRejectedValueOnce(new Error("denied"));
    openExternalLink("https://example.com");
    await vi.waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(
        "Couldn't open https://example.com: denied",
        "error"
      );
    });
  });
  it("openExternalLink routes to the external-url bridge call", () => {
    openExternalLink("https://example.com");
    expect(openExternalUrl).toHaveBeenCalledWith("https://example.com");
  });
});

describe("findLinks", () => {
  it("finds URLs and paths in prose, in order, with offsets", () => {
    const text = "see https://x.dev/a/b.html and src/a.ts:4.";
    const links = findLinks(text);
    expect(links.map((l) => l.token)).toEqual([
      "https://x.dev/a/b.html",
      "src/a.ts:4",
    ]);
    for (const l of links) {
      expect(text.slice(l.start, l.end)).toBe(l.token);
    }
  });
  it("leaves trailing sentence punctuation off a URL", () => {
    expect(findLinks("(at https://x.dev/docs).").map((l) => l.token)).toEqual([
      "https://x.dev/docs",
    ]);
  });
  it("keeps a `)` that closes a `(` inside the URL", () => {
    expect(
      findLinks("see https://x.dev/wiki/Rust_(lang).").map((l) => l.token)
    ).toEqual(["https://x.dev/wiki/Rust_(lang)"]);
  });
  it("finds nothing in plain prose", () => {
    expect(findLinks("e.g. nothing here")).toEqual([]);
  });
});

describe("linkTarget", () => {
  it("reads an http(s) URL as a URL", () => {
    expect(linkTarget("https://x.dev")).toEqual({
      kind: "url",
      url: "https://x.dev",
    });
  });
  it("reads a path, dropping a #L line anchor", () => {
    expect(linkTarget("src/a.ts")).toEqual({ kind: "path", path: "src/a.ts" });
    expect(linkTarget("src/a.ts#L4-L9")).toEqual({
      kind: "path",
      path: "src/a.ts",
    });
  });
  it("reads a file:// URL as its absolute path", () => {
    expect(linkTarget("file:///Users/me/a%20b.md")).toEqual({
      kind: "path",
      path: "/Users/me/a b.md",
    });
  });
  it("reads an upper-case scheme as a URL", () => {
    expect(linkTarget("HTTPS://x.dev")?.kind).toBe("url");
  });
  it("drops any heading anchor from a file link", () => {
    expect(linkTarget("docs/a.md#usage")).toEqual({
      kind: "path",
      path: "docs/a.md",
    });
  });
  it("reads a file:// URL's path whatever its host, anchor or escapes", () => {
    expect(linkTarget("file://localhost/Users/me/a%23b.md#L3")).toEqual({
      kind: "path",
      path: "/Users/me/a#b.md",
    });
  });
  it("opens nothing for other schemes or bare anchors", () => {
    expect(linkTarget("javascript:alert(1)")).toBeNull();
    expect(linkTarget("ftp://x.dev/a.txt")).toBeNull();
    expect(linkTarget("#usage")).toBeNull();
  });
});

test("an @ mention links its path, not the @", () => {
  expect(findLinks("read @/Users/me/Downloads/slip.pdf now")).toEqual([
    { end: 34, start: 6, token: "/Users/me/Downloads/slip.pdf" },
  ]);
  expect(findLinks("see @src/a.ts")).toEqual([
    { end: 13, start: 5, token: "src/a.ts" },
  ]);
  // A scoped package is a path segment, not a mention.
  expect(findLinks("in node_modules/@scope/pkg/index.js")[0]?.token).toBe(
    "node_modules/@scope/pkg/index.js"
  );
});

test("a quoted @ mention links the whole path, spaces and all", () => {
  const text = 'look @"/Users/me/my notes/a b.pdf" please';
  const [found] = findLinks(text);
  expect(found?.token).toBe("/Users/me/my notes/a b.pdf");
  expect(text.slice(found?.start, found?.end)).toBe(
    "/Users/me/my notes/a b.pdf"
  );
});

test("a file outside every project opens only after the user says so", async () => {
  openPath
    .mockRejectedValueOnce(
      new Error(
        "kind:outside-roots: path outside a known project or session root"
      )
    )
    .mockResolvedValueOnce(undefined);
  openFileToken("/proj", "/Users/me/Downloads/slip.pdf", false);
  await vi.waitFor(() =>
    expect(useOutsideOpen.getState().request?.path).toBe(
      "/Users/me/Downloads/slip.pdf"
    )
  );
  useOutsideOpen.getState().request?.confirm();
  expect(openPath).toHaveBeenLastCalledWith(
    "/proj",
    "/Users/me/Downloads/slip.pdf",
    true
  );
});
