import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The highlighter module keeps its shiki singleton in module-level state, so
// each test resets the module registry and re-imports fresh — otherwise an
// earlier test's already-initialised singleton would make later assertions
// (like "the core factory is only called once") pass vacuously.
beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("@shikijs/core");
  // The "never throws" test below mocks the typescript grammar module to
  // reject; without unmocking it here, that mock leaks into any later test
  // that loads typescript for real (e.g. the retry-after-failure test).
  vi.doUnmock("@shikijs/langs/typescript");
});

describe("highlightLines", () => {
  it("highlights a TypeScript snippet with colored spans", async () => {
    const { highlightLines } = await import("./highlighter.ts");

    const lines = await highlightLines("const a = 1;", "typescript");

    expect(lines).toHaveLength(1);
    const hasColor = lines[0].some((span) => Boolean(span.color));
    expect(hasColor).toBe(true);
  });

  it("carries shiki's italic/bold through instead of dropping it", async () => {
    // fontStyle used to be discarded, so an italic comment rendered upright.
    const { highlightLines } = await import("./highlighter.ts");

    const lines = await highlightLines("// a comment", "typescript");

    expect(lines[0].some((span) => span.italic)).toBe(true);
  });

  it("gives an accessed property its own colour rather than the variable one", async () => {
    // `variable.other.property` / `support.variable.property` get their own
    // violet; every other scope in the `variable` family stays
    // near-neutral. Both used to share `syntax.variable`, so `a.alpha` read as
    // one flat run.
    const { tokens } = await import("../theme/tokens.ts");
    const { highlightLines } = await import("./highlighter.ts");

    const lines = await highlightLines("const b = a.alpha;", "typescript");

    const property = lines[0].find((span) => span.text.includes("alpha"));
    expect(property?.color).toBe(tokens.color.syntax.property);
    const object = lines[0].find((span) => span.text.trim() === "a");
    expect(object?.color).toBe(tokens.color.syntax.variable);
  });

  it("peekHighlight answers synchronously once a highlight has resolved", async () => {
    // The anti-flash path: DiffFeed virtualizes, so a card scrolled back into
    // view remounts and must render coloured on its first frame rather than
    // waiting a microtask for a promise it already has the answer to.
    const { highlightLines, peekHighlight } = await import("./highlighter.ts");

    expect(peekHighlight("const a = 1;", "typescript")).toBeUndefined();
    const lines = await highlightLines("const a = 1;", "typescript");

    expect(peekHighlight("const a = 1;", "typescript")).toEqual(lines);
    // Keyed on both content and language, like the promise caches.
    expect(peekHighlight("const a = 1;", "rust")).toBeUndefined();
    expect(peekHighlight("const b = 2;", "typescript")).toBeUndefined();
  });

  it("peekHighlight never serves a degraded result as if it were real", async () => {
    // A failed tokenization deliberately un-caches itself so the next call
    // retries for real; the synchronous cache has to honour that too, or the
    // plain-text degradation would be served forever.
    vi.doMock("@shikijs/langs/typescript", () => {
      throw new Error("network down");
    });
    const { highlightLines, peekHighlight } = await import("./highlighter.ts");

    await highlightLines("const a = 1;", "typescript");

    expect(peekHighlight("const a = 1;", "typescript")).toBeUndefined();
  });

  it("falls back to a single plain span per line for an unknown language", async () => {
    const { highlightLines } = await import("./highlighter.ts");

    const lines = await highlightLines("line one\nline two", "cobol");

    expect(lines).toEqual([[{ text: "line one" }], [{ text: "line two" }]]);
  });

  it("never throws when the grammar dynamic import fails", async () => {
    vi.doMock("@shikijs/langs/typescript", () => {
      throw new Error("network down");
    });
    const { highlightLines } = await import("./highlighter.ts");

    const lines = await highlightLines("const a = 1;", "typescript");

    expect(lines).toEqual([[{ text: "const a = 1;" }]]);
  });

  it("reuses the highlighter core singleton across repeated calls", async () => {
    // The ESM module namespace isn't configurable, so vi.spyOn can't patch
    // an export in place — mock the module with a wrapped, still-real
    // factory instead, so the spy proves genuine reuse rather than passing
    // vacuously against a no-op.
    const actual =
      await vi.importActual<typeof import("@shikijs/core")>("@shikijs/core");
    const factorySpy = vi.fn(actual.createHighlighterCore);
    vi.doMock("@shikijs/core", () => ({
      ...actual,
      createHighlighterCore: factorySpy,
    }));

    const { highlightLines } = await import("./highlighter.ts");
    await highlightLines("const a = 1;", "typescript");
    await highlightLines("const b = 2;", "javascript");
    await highlightLines("let c = 3;", "typescript");

    expect(factorySpy).toHaveBeenCalledTimes(1);
  });

  it("runs the core factory exactly once for two concurrent calls requesting different new languages", async () => {
    const actual =
      await vi.importActual<typeof import("@shikijs/core")>("@shikijs/core");
    const factorySpy = vi.fn(actual.createHighlighterCore);
    vi.doMock("@shikijs/core", () => ({
      ...actual,
      createHighlighterCore: factorySpy,
    }));

    const { highlightLines } = await import("./highlighter.ts");

    const [rustLines, tomlLines] = await Promise.all([
      highlightLines("let x = 1;", "rust"),
      highlightLines("key = 1", "toml"),
    ]);

    const rustHasColor = rustLines.some((line) =>
      line.some((span) => Boolean(span.color))
    );
    const tomlHasColor = tomlLines.some((line) =>
      line.some((span) => Boolean(span.color))
    );
    expect(rustHasColor).toBe(true);
    expect(tomlHasColor).toBe(true);
    expect(factorySpy).toHaveBeenCalledTimes(1);
  });

  it("does not double-register a grammar for two concurrent calls to the same new language", async () => {
    const actual =
      await vi.importActual<typeof import("@shikijs/core")>("@shikijs/core");
    const loadLanguageSpy = vi.fn();
    const factorySpy = vi.fn(
      async (...args: Parameters<typeof actual.createHighlighterCore>) => {
        const highlighter = await actual.createHighlighterCore(...args);
        const originalLoadLanguage = highlighter.loadLanguage.bind(highlighter);
        loadLanguageSpy.mockImplementation(
          (...loadArgs: Parameters<typeof originalLoadLanguage>) =>
            originalLoadLanguage(...loadArgs)
        );
        highlighter.loadLanguage = loadLanguageSpy;
        return highlighter;
      }
    );
    vi.doMock("@shikijs/core", () => ({
      ...actual,
      createHighlighterCore: factorySpy,
    }));

    const { highlightLines } = await import("./highlighter.ts");

    const [first, second] = await Promise.all([
      highlightLines("x = 1", "python"),
      highlightLines("y = 2", "python"),
    ]);

    const firstHasColor = first.some((line) =>
      line.some((span) => Boolean(span.color))
    );
    const secondHasColor = second.some((line) =>
      line.some((span) => Boolean(span.color))
    );
    expect(firstHasColor).toBe(true);
    expect(secondHasColor).toBe(true);
    expect(factorySpy).toHaveBeenCalledTimes(1);
    expect(loadLanguageSpy).toHaveBeenCalledTimes(1);
  });

  it("retries the core highlighter after an initial init failure instead of poisoning the singleton forever", async () => {
    const actual =
      await vi.importActual<typeof import("@shikijs/core")>("@shikijs/core");
    let callCount = 0;
    const factorySpy = vi.fn(
      (...args: Parameters<typeof actual.createHighlighterCore>) => {
        callCount += 1;
        if (callCount === 1) {
          return Promise.reject(new Error("engine init failed"));
        }
        return actual.createHighlighterCore(...args);
      }
    );
    vi.doMock("@shikijs/core", () => ({
      ...actual,
      createHighlighterCore: factorySpy,
    }));

    const { highlightLines } = await import("./highlighter.ts");

    const first = await highlightLines("const a = 1;", "typescript");
    expect(first).toEqual([[{ text: "const a = 1;" }]]);

    const second = await highlightLines("const a = 1;", "typescript");
    const secondHasColor = second.some((line) =>
      line.some((span) => Boolean(span.color))
    );
    expect(secondHasColor).toBe(true);

    expect(factorySpy).toHaveBeenCalledTimes(2);
  });

  it("reuses a cached tokenization for a repeated call with the same code and language", async () => {
    // A remounted DiffHunk (virtualization unmounts/remounts cards while
    // scrolling) calls highlightLines again for content it already
    // highlighted; this proves the second call skips re-tokenizing rather
    // than redoing the (real, unmocked) work.
    const actual =
      await vi.importActual<typeof import("@shikijs/core")>("@shikijs/core");
    const tokenizeSpy = vi.fn();
    const factorySpy = vi.fn(
      async (...args: Parameters<typeof actual.createHighlighterCore>) => {
        const highlighter = await actual.createHighlighterCore(...args);
        const originalTokenize = highlighter.codeToTokensBase.bind(highlighter);
        tokenizeSpy.mockImplementation(
          (...tokenizeArgs: Parameters<typeof originalTokenize>) =>
            originalTokenize(...tokenizeArgs)
        );
        highlighter.codeToTokensBase = tokenizeSpy;
        return highlighter;
      }
    );
    vi.doMock("@shikijs/core", () => ({
      ...actual,
      createHighlighterCore: factorySpy,
    }));

    const { highlightLines } = await import("./highlighter.ts");

    const first = await highlightLines("const a = 1;", "typescript");
    const second = await highlightLines("const a = 1;", "typescript");

    expect(second).toEqual(first);
    expect(tokenizeSpy).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight tokenization for concurrent calls with identical code and language", async () => {
    const { highlightLines } = await import("./highlighter.ts");

    const first = highlightLines("const a = 1;", "typescript");
    const second = highlightLines("const a = 1;", "typescript");

    expect(second).toBe(first);
    await Promise.all([first, second]);
  });

  it("does not collide across different content, even for the same language", async () => {
    const { highlightLines } = await import("./highlighter.ts");

    const first = highlightLines("const a = 1;", "typescript");
    const second = highlightLines("const b = 2;", "typescript");

    expect(second).not.toBe(first);
    await Promise.all([first, second]);
  });

  it("bounds the cache: an entry older than the cap is evicted and gets a fresh promise on the next identical call", async () => {
    const { highlightLines, MAX_HIGHLIGHT_CACHE_ENTRIES } = await import(
      "./highlighter.ts"
    );

    const first = highlightLines("line 0", "text");
    for (let i = 1; i <= MAX_HIGHLIGHT_CACHE_ENTRIES; i += 1) {
      highlightLines(`line ${i}`, "text");
    }
    const firstAgain = highlightLines("line 0", "text");

    expect(firstAgain).not.toBe(first);
    await Promise.all([first, firstAgain]);
  });

  it("does not evict an entry that's still within the cap", async () => {
    const { highlightLines, MAX_HIGHLIGHT_CACHE_ENTRIES } = await import(
      "./highlighter.ts"
    );

    const first = highlightLines("line 0", "text");
    for (let i = 1; i < MAX_HIGHLIGHT_CACHE_ENTRIES; i += 1) {
      highlightLines(`line ${i}`, "text");
    }
    const firstAgain = highlightLines("line 0", "text");

    expect(firstAgain).toBe(first);
    await Promise.all([first, firstAgain]);
  });

  it("keeps large whole-file highlights in a separate cache so they can't evict the hunk cache's entries", async () => {
    // Regression test: a single shared, count-capped cache would treat a
    // ~1 MB whole-file highlight (FileViewer) as "one entry", identical in
    // weight to a two-line diff hunk (DiffHunk) — so browsing enough large
    // files in one session could push the shared cache past its cap and
    // evict hunks DiffFeed still needs mid-scroll, flashing them back to
    // plain text.
    const { highlightLines, MAX_HIGHLIGHT_CACHE_ENTRIES } = await import(
      "./highlighter.ts"
    );

    const hunkPromise = highlightLines("const a = 1;", "text");
    await hunkPromise;

    // Enough distinct large ("whole file") highlight calls to exceed the
    // hunk cache's own 300-entry cap, were they sharing one FIFO cache.
    for (let i = 0; i < MAX_HIGHLIGHT_CACHE_ENTRIES + 5; i += 1) {
      // Comfortably over the large-content threshold (4000 chars).
      // biome-ignore lint/performance/noAwaitInLoops: the cache's eviction order is what this tests.
      await highlightLines(`line ${i}\n`.repeat(500), "text");
    }

    // The original small hunk entry is still cached (same promise
    // identity) — a shared cache would have evicted it via FIFO long
    // before the loop above finished.
    const hunkAgain = highlightLines("const a = 1;", "text");
    expect(hunkAgain).toBe(hunkPromise);
  });

  it("evicts the large-content cache at its own (smaller) bound, leaving the hunk cache's entries intact", async () => {
    // MAX_LARGE_HIGHLIGHT_CACHE_ENTRIES has no consumer outside this module;
    // a refactor that broke `cacheFor`/`capFor` (e.g. routing large content
    // through the hunk cache's 300-entry cap instead of this cache's own
    // 20-entry one) would leave every other test in this file green while
    // silently reintroducing unbounded large-entry retention. This test
    // asserts the large cache's own bound directly, and that reaching it
    // never touches the separate hunk cache.
    const { highlightLines, MAX_LARGE_HIGHLIGHT_CACHE_ENTRIES } = await import(
      "./highlighter.ts"
    );

    // Always comfortably over the 4000-char large-content threshold
    // regardless of `i`'s digit count, so every call here is unambiguously
    // routed to the large-content cache (unlike the digit-count-sensitive
    // fixture in the test above).
    const large = (i: number) => `large-${i}\n${"x".repeat(4500)}`;

    // A hunk-sized entry, well under the threshold — lives in the separate
    // hunk cache and must survive every eviction below, since the large
    // cache's own cap must never reach into it.
    const hunkPromise = highlightLines("const a = 1;", "text");
    await hunkPromise;

    const firstLarge = highlightLines(large(0), "text");
    await firstLarge;

    // One more distinct large entry than the large cache's own cap —
    // enough to evict the oldest large entry (`firstLarge`) purely by the
    // large cache's own bound, well short of the hunk cache's much bigger
    // 300-entry cap.
    for (let i = 1; i <= MAX_LARGE_HIGHLIGHT_CACHE_ENTRIES; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: the cache's eviction order is what this tests.
      await highlightLines(large(i), "text");
    }

    const firstLargeAgain = highlightLines(large(0), "text");
    expect(firstLargeAgain).not.toBe(firstLarge);

    const hunkAgain = highlightLines("const a = 1;", "text");
    expect(hunkAgain).toBe(hunkPromise);

    await Promise.all([firstLargeAgain, hunkAgain]);
  });
});

describe("langForPath", () => {
  it("maps known extensions to shiki language ids", async () => {
    const { langForPath } = await import("./highlighter.ts");

    expect(langForPath("x/y.tsx")).toBe("tsx");
    expect(langForPath("a/b.ts")).toBe("typescript");
    expect(langForPath("a/b.js")).toBe("javascript");
    expect(langForPath("src/main.rs")).toBe("rust");
    expect(langForPath("script.py")).toBe("python");
    expect(langForPath("README.md")).toBe("markdown");
    expect(langForPath("package.json")).toBe("json");
    expect(langForPath("Cargo.toml")).toBe("toml");
    expect(langForPath("styles.css")).toBe("css");
    expect(langForPath("index.html")).toBe("html");
  });

  it("falls back to text for unknown or missing extensions", async () => {
    const { langForPath } = await import("./highlighter.ts");

    expect(langForPath("a/b.unknownext")).toBe("text");
    expect(langForPath("LICENSE")).toBe("text");
    expect(langForPath("a/b.")).toBe("text");
  });

  it("recognises extensionless files that are still code", async () => {
    // `Makefile` used to fall through to plain text purely because it has no
    // dot to key off — the name is the identity for this whole family.
    const { langForPath } = await import("./highlighter.ts");

    expect(langForPath("Makefile")).toBe("make");
    expect(langForPath("a/b/Dockerfile")).toBe("dockerfile");
    expect(langForPath("Gemfile")).toBe("ruby");
  });

  it("treats a leading dot as part of the name, not an extension", async () => {
    // `.gitignore`'s "extension" is `gitignore`, which is nobody's language —
    // splitting on the last dot without this returns garbage for every dotfile.
    const { langForPath } = await import("./highlighter.ts");

    expect(langForPath(".gitignore")).toBe("ini");
    expect(langForPath("a/b/.env")).toBe("bash");
  });

  it("covers the everyday languages that used to render as plain text", async () => {
    const { langForPath } = await import("./highlighter.ts");

    expect(langForPath("ci.yml")).toBe("yaml");
    expect(langForPath("deploy.yaml")).toBe("yaml");
    expect(langForPath("build.sh")).toBe("bash");
    expect(langForPath("main.go")).toBe("go");
    expect(langForPath("schema.sql")).toBe("sql");
    expect(langForPath("App.java")).toBe("java");
    expect(langForPath("mod.cjs")).toBe("javascript");
    expect(langForPath("mod.mts")).toBe("typescript");
    expect(langForPath("styles.scss")).toBe("scss");
    expect(langForPath("tsconfig.jsonc")).toBe("jsonc");
  });
});

/**
 * The value pins in `themes.test.ts` fix the palette's values; they cannot
 * prove any token ever reaches the slot it should. These
 * do — they run the real shiki path and assert which colour each token lands
 * on, which is the only place a scope→slot mapping mistake shows up.
 */
describe("the palette puts each token on its slot", () => {
  /** `text` → the colour the highlighter gave it, for one snippet. */
  async function colorsFor(source: string, lang: string) {
    const { highlightLines } = await import("./highlighter.ts");
    const lines = await highlightLines(source, lang);
    const found = new Map<string, string | undefined>();
    for (const line of lines) {
      for (const span of line) {
        const key = span.text.trim();
        if (key.length > 0 && !found.has(key)) {
          found.set(key, span.color);
        }
      }
    }
    return found;
  }

  it("leaves ordinary operators near-neutral instead of colouring them like keywords", async () => {
    // Ordinary operators (`keyword.operator`) stay near-neutral. Without an
    // explicit rule, TextMate prefix-matching sends every one of these to the
    // `keyword` rule — which, with a teal keyword, makes the operators the
    // loudest thing on a line of TypeScript.
    const { tokens } = await import("../theme/tokens.ts");
    const colors = await colorsFor(
      "const t = a + b === c && !d;",
      "typescript"
    );

    for (const op of ["+", "===", "&&", "!", "="]) {
      expect(colors.get(op), `operator ${op}`).toBe(
        tokens.color.syntax.punctuation
      );
    }
  });

  it("keeps the expression keywords teal, though TextMate scopes them as operators", async () => {
    // The other half of the rule above: `typeof`/`instanceof`/`new`/`delete`
    // go back on the keyword hue, so the
    // generic operator rule must not swallow them.
    const { tokens } = await import("../theme/tokens.ts");
    const colors = await colorsFor(
      "const t = typeof a; const u = new B(); delete o.k;",
      "typescript"
    );

    for (const word of ["typeof", "new", "delete"]) {
      expect(colors.get(word), word).toBe(tokens.color.syntax.keyword);
    }
  });

  it("gives a const binding the property violet, not the brightest ink in the palette", async () => {
    // `variable.other.constant` → violet. Folding it into `syntaxConstant`
    // painted most identifiers in a TS file the *brightest* colour available.
    const { tokens } = await import("../theme/tokens.ts");
    const colors = await colorsFor("const total = 1;", "typescript");

    expect(colors.get("total")).toBe(tokens.color.syntax.property);
  });

  it("paints a JSON key in the keyword teal", async () => {
    // `support.type.property-name.json` → the keyword teal.
    const { tokens } = await import("../theme/tokens.ts");
    const colors = await colorsFor('{ "name": "kriyon" }', "json");

    // The quotes tokenize as their own punctuation spans; the key itself is
    // the span in between.
    expect(colors.get("name")).toBe(tokens.color.syntax.keyword);
  });

  it("leaves an object-literal key on the variable ink", async () => {
    // `meta.object-literal.key` → variable ink: only an *accessed* property gets
    // the violet, which is the distinction the `syntaxProperty` slot exists
    // for. Pinned here because CodeMirror has to reproduce it from a
    // different tag, and this is the value it has to match.
    const { tokens } = await import("../theme/tokens.ts");
    const colors = await colorsFor("const o = { alpha: 1 };", "typescript");

    expect(colors.get("alpha")).toBe(tokens.color.syntax.variable);
  });

  it("bases unclaimed text on the editor's own ink", async () => {
    // Basing shiki on the app's UI ink
    // instead left plain text a different grey from the editor's, and made
    // `syntaxConstant` render *brighter* than the text around it —
    // the "fourth highlighted category" the palette notes say was avoided.
    // Markdown prose is the cleanest probe: no rule below the base claims it,
    // so it renders as exactly the fallback.
    const { tokens } = await import("../theme/tokens.ts");
    const colors = await colorsFor("hello plain words", "markdown");

    expect(colors.get("hello plain words")).toBe(tokens.color.editorInk);
  });
});
