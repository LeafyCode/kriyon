import { describe, expect, it } from "vitest";
import { detectTrigger } from "./detect.ts";

describe("detectTrigger", () => {
  it("detects a slash command at input start", () => {
    expect(detectTrigger("/comm", 5)).toEqual({
      kind: "slash",
      query: "comm",
      start: 0,
      end: 5,
    });
  });

  it("triggers a slash command even after ordinary prose", () => {
    expect(detectTrigger("fix the /path bug", 13)).toEqual({
      kind: "slash",
      query: "path",
      start: 8,
      end: 13,
    });
  });

  it("triggers a slash command after prose plus a mention", () => {
    expect(detectTrigger("/cmd @x Hello world /impr", 25)).toEqual({
      kind: "slash",
      query: "impr",
      start: 20,
      end: 25,
    });
  });

  it("closes the slash menu once a space follows the command", () => {
    expect(detectTrigger("/commit msg", 11)).toBeNull();
  });

  it("detects an @ mention at a word boundary", () => {
    expect(detectTrigger("see @src/mai", 12)).toEqual({
      kind: "mention",
      query: "src/mai",
      start: 4,
      end: 12,
    });
  });

  it("detects @ at the very start", () => {
    expect(detectTrigger("@RE", 3)).toEqual({
      kind: "mention",
      query: "RE",
      start: 0,
      end: 3,
    });
  });

  it("does not treat an email-like @ as a mention", () => {
    expect(detectTrigger("mail me@x", 9)).toBeNull();
  });

  it("detects a second slash command after an earlier command and mention", () => {
    expect(detectTrigger("/a @x /b", 8)).toEqual({
      kind: "slash",
      query: "b",
      start: 6,
      end: 8,
    });
  });

  it("detects bash and memory modes", () => {
    expect(detectTrigger("!ls -la", 3)).toEqual({ kind: "mode", mode: "bash" });
    expect(detectTrigger("#remember this", 5)).toEqual({
      kind: "mode",
      mode: "memory",
    });
  });

  it("returns null for ordinary text", () => {
    expect(detectTrigger("hello world", 5)).toBeNull();
  });
});
