import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DirChevron, DirIcon, FileIcon, fileIconSpec } from "./fileIcon.tsx";
import { langForPath } from "./highlighter.ts";

/** Hoisted per Biome's `useTopLevelRegex`. */
const TS_LANGS = /^(typescript|tsx)$/;

describe("fileIconSpec", () => {
  it("keys off the same language resolver the highlighter uses", () => {
    // The whole point of resolving through `langForPath` rather than a second
    // extension table: a file that highlights as TypeScript cannot end up
    // with some other language's icon, and adding a language in one place
    // can't leave the icon mapping behind.
    for (const path of ["a.ts", "b/c.tsx", "d.mts"]) {
      expect(langForPath(path)).toMatch(TS_LANGS);
      expect(fileIconSpec(path).color).toBeTruthy();
    }
    expect(fileIconSpec("a.ts")).toEqual(fileIconSpec("deep/nested/other.ts"));
  });

  it("gives different languages different icons", () => {
    const ts = fileIconSpec("a.ts");
    const json = fileIconSpec("a.json");
    const css = fileIconSpec("a.css");
    expect(ts.Icon).not.toBe(json.Icon);
    expect(json.Icon).not.toBe(css.Icon);
  });

  it("recognises extensionless files the highlighter already knows", () => {
    // These have no dot to key an extension off, so without name resolution
    // they'd take the generic fallback.
    const plain = fileIconSpec("NOTES");
    expect(fileIconSpec("Dockerfile")).toEqual(fileIconSpec("a/Dockerfile"));
    expect(fileIconSpec("Dockerfile")).not.toEqual(plain);
    expect(fileIconSpec("Makefile")).not.toEqual(plain);
    expect(fileIconSpec(".gitignore")).not.toEqual(plain);
  });

  it("treats images and lockfiles as their own kinds, not as code", () => {
    // Neither has a language, so without their own entries both would fall
    // through to the generic document icon.
    const png = fileIconSpec("logo.png");
    const lock = fileIconSpec("pnpm-lock.yaml");
    const plain = fileIconSpec("NOTES");
    expect(png.Icon).not.toBe(plain.Icon);
    expect(lock.Icon).not.toBe(plain.Icon);
    // A lockfile must not inherit YAML's icon just because it ends in .yaml.
    expect(lock.Icon).not.toBe(fileIconSpec("ci.yaml").Icon);
  });

  it("falls back to a plain document for anything unknown", () => {
    expect(fileIconSpec("LICENSE")).toEqual(fileIconSpec("whatever.zzz"));
  });
});

describe("icon components", () => {
  it("render an svg for files, directories, and the chevron", () => {
    const file = render(<FileIcon path="a.ts" />);
    expect(file.container.querySelector("svg")).not.toBeNull();

    const dir = render(<DirIcon open={false} />);
    expect(dir.container.querySelector("svg")).not.toBeNull();

    const chevron = render(<DirChevron open={false} />);
    expect(chevron.container.querySelector("svg")).not.toBeNull();
  });

  it("rotates the chevron only when the directory is open", () => {
    const closed = render(<DirChevron open={false} />);
    const open = render(<DirChevron open={true} />);

    expect(closed.container.querySelector("svg")).toHaveStyle({
      transform: "rotate(0deg)",
    });
    expect(open.container.querySelector("svg")).toHaveStyle({
      transform: "rotate(90deg)",
    });
  });

  it("shows an open folder only while expanded", () => {
    const closed = render(<DirIcon open={false} />);
    const open = render(<DirIcon open={true} />);
    // Distinct glyphs, so the row's state is readable from the icon alone and
    // not only from the chevron.
    expect(closed.container.innerHTML).not.toBe(open.container.innerHTML);
  });
});
