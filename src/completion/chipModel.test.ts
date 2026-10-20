import { describe, expect, it } from "vitest";
import {
  buildFragment,
  caretOffsetInValue,
  locateRange,
  makeChip,
  serializeEditable,
} from "./chipModel.ts";

describe("serializeEditable", () => {
  it("concatenates text nodes and chip token text in document order", () => {
    const div = document.createElement("div");
    div.appendChild(document.createTextNode("/compact "));
    div.appendChild(makeChip(document, "mention", "@src/main.rs"));
    div.appendChild(document.createTextNode(" please"));
    expect(serializeEditable(div)).toBe("/compact @src/main.rs please");
  });

  it("treats a <br> as a newline", () => {
    const div = document.createElement("div");
    div.appendChild(document.createTextNode("line one"));
    div.appendChild(document.createElement("br"));
    div.appendChild(document.createTextNode("line two"));
    expect(serializeEditable(div)).toBe("line one\nline two");
  });

  it("returns an empty string for an empty editable", () => {
    const div = document.createElement("div");
    expect(serializeEditable(div)).toBe("");
  });
});

describe("makeChip", () => {
  it("builds an atomic, tagged chip span", () => {
    const chip = makeChip(document, "command", "/compact");
    expect(chip.tagName).toBe("SPAN");
    expect(chip.getAttribute("contenteditable")).toBe("false");
    expect(chip.hasAttribute("data-chip")).toBe(true);
    expect(chip.getAttribute("data-kind")).toBe("command");
    expect(chip.textContent).toBe("/compact");
  });
});

describe("buildFragment", () => {
  function roundTrip(value: string): string {
    const div = document.createElement("div");
    div.appendChild(buildFragment(document, value));
    return serializeEditable(div);
  }

  it("round-trips plain text with no tokens", () => {
    expect(roundTrip("hello world")).toBe("hello world");
  });

  it("round-trips a leading command plus a mention and an agent", () => {
    const value = "/compact see @src/main.rs and @agent-Explore";
    expect(roundTrip(value)).toBe(value);
  });

  it("builds a data-kind=command chip for a leading slash command", () => {
    const div = document.createElement("div");
    div.appendChild(buildFragment(document, "/compact free up ctx"));
    const chip = div.querySelector("[data-chip]");
    expect(chip?.getAttribute("data-kind")).toBe("command");
    expect(chip?.textContent).toBe("/compact");
  });

  it("builds a data-kind=agent chip for an @agent- mention", () => {
    const div = document.createElement("div");
    div.appendChild(buildFragment(document, "ping @agent-Explore now"));
    const chip = div.querySelector('[data-kind="agent"]');
    expect(chip?.textContent).toBe("@agent-Explore");
  });

  it("round-trips an empty string to no children", () => {
    const div = document.createElement("div");
    div.appendChild(buildFragment(document, ""));
    expect(div.childNodes.length).toBe(0);
    expect(serializeEditable(div)).toBe("");
  });

  it("builds a data-kind=bash mode chip for a leading '!', then plain text", () => {
    const div = document.createElement("div");
    div.appendChild(buildFragment(document, "! ls -la"));
    const chip = div.firstElementChild;
    expect(chip?.getAttribute("data-chip")).toBe("");
    expect(chip?.getAttribute("data-kind")).toBe("bash");
    expect(chip?.textContent).toBe("!");
    expect(div.childNodes[1].nodeType).toBe(Node.TEXT_NODE);
    expect(div.childNodes[1].textContent).toBe(" ls -la");
    expect(serializeEditable(div)).toBe("! ls -la");
  });

  it("builds a data-kind=memory mode chip for a leading '#'", () => {
    const div = document.createElement("div");
    div.appendChild(buildFragment(document, "#note"));
    const chip = div.firstElementChild;
    expect(chip?.getAttribute("data-kind")).toBe("memory");
    expect(chip?.textContent).toBe("#");
    expect(div.childNodes[1].textContent).toBe("note");
    expect(serializeEditable(div)).toBe("#note");
  });

  it("does not create a mode chip for a leading '/command'", () => {
    const div = document.createElement("div");
    div.appendChild(buildFragment(document, "/cmd free up ctx"));
    const chip = div.firstElementChild;
    expect(chip?.getAttribute("data-kind")).toBe("command");
    expect(chip?.textContent).toBe("/cmd");
    expect(div.querySelector('[data-kind="bash"]')).toBeNull();
    expect(div.querySelector('[data-kind="memory"]')).toBeNull();
  });

  it("leaves a mid-text '!'/'#' as plain (not index 0)", () => {
    const div = document.createElement("div");
    div.appendChild(buildFragment(document, "run ! and #note"));
    expect(div.querySelector("[data-chip]")).toBeNull();
    expect(serializeEditable(div)).toBe("run ! and #note");
  });
});

describe("caretOffsetInValue", () => {
  function build(value: string): HTMLDivElement {
    const div = document.createElement("div");
    div.appendChild(buildFragment(document, value));
    return div;
  }

  it("returns 0 at the very start (root, child-index 0)", () => {
    const div = build("/compact free up");
    expect(caretOffsetInValue(div, div, 0)).toBe(0);
  });

  it("returns the offset inside a text node", () => {
    const div = build("hello world");
    const textNode = div.firstChild as Text;
    expect(caretOffsetInValue(div, textNode, 5)).toBe(5);
  });

  it("returns the chip's full length when the caret sits right after it (root, child-index)", () => {
    const div = build("/compact free up");
    // children: [chip "/compact", text " free up"] — index 1 is "right after
    // the chip".
    expect(caretOffsetInValue(div, div, 1)).toBe("/compact".length);
  });

  it("adds the offset within the trailing text node after a chip", () => {
    const div = build("/compact free up");
    const trailing = div.childNodes[1] as Text; // " free up"
    // 3 chars into " fr" past the chip.
    expect(caretOffsetInValue(div, trailing, 3)).toBe("/compact".length + 3);
  });
});

describe("locateRange", () => {
  it("maps a span inside a single text node", () => {
    const div = document.createElement("div");
    div.appendChild(document.createTextNode("hello world"));
    const loc = locateRange(div, "hello world", 6, 11);
    expect(loc).not.toBeNull();
    expect(loc?.startNode).toBe(div.firstChild);
    expect(loc?.startOffset).toBe(6);
    expect(loc?.endNode).toBe(div.firstChild);
    expect(loc?.endOffset).toBe(11);
  });

  it("maps a span in the text node following a chip", () => {
    const div = document.createElement("div");
    div.appendChild(makeChip(document, "command", "/compact"));
    div.appendChild(document.createTextNode(" free up"));
    const value = "/compact free up";
    const loc = locateRange(div, value, 8, 12);
    expect(loc?.startNode).toBe(div.lastChild);
    expect(loc?.startOffset).toBe(0);
    expect(loc?.endOffset).toBe(4);
  });

  it("returns null when the span runs past the value length", () => {
    const div = document.createElement("div");
    div.appendChild(document.createTextNode("hi"));
    expect(locateRange(div, "hi", 0, 10)).toBeNull();
  });

  it("returns null when no single text node covers the whole span", () => {
    const div = document.createElement("div");
    div.appendChild(makeChip(document, "command", "/compact"));
    const value = "/compact";
    expect(locateRange(div, value, 0, 8)).toBeNull();
  });
});
