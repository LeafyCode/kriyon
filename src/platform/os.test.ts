import { afterEach, describe, expect, it } from "vitest";
import { pretendPlatform } from "../test/platform.ts";
import { fileManagerName, isMacPlatform, thisComputer } from "./os.ts";

let restore: () => void = () => undefined;
afterEach(() => restore());

describe("platform detection", () => {
  it("reads a Mac webview as macOS", () => {
    restore = pretendPlatform("mac");
    expect(isMacPlatform()).toBe(true);
    expect(thisComputer()).toBe("this Mac");
    expect(fileManagerName()).toBe("Finder");
  });

  it("reads a WebView2 webview as Windows", () => {
    restore = pretendPlatform("windows");
    expect(isMacPlatform()).toBe(false);
    expect(thisComputer()).toBe("this PC");
    expect(fileManagerName()).toBe("File Explorer");
  });

  it("knows a Mac by its user agent when the platform field is empty", () => {
    restore = pretendPlatform("mac");
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: "",
    });
    expect(isMacPlatform()).toBe(true);
  });
});
