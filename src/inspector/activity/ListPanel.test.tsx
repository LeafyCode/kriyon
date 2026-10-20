import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ListPanel } from "./ListPanel.tsx";

describe("ListPanel", () => {
  it("renders the empty message when there are no items", () => {
    render(
      <ListPanel
        empty="Nothing here"
        getKey={(item) => item}
        items={[]}
        label="Things"
        renderItem={(item) => <span>{item}</span>}
      />
    );
    expect(screen.getByText("Nothing here")).toBeTruthy();
    expect(screen.getByText("Things")).toBeTruthy();
  });

  it("renders one row per item via renderItem", () => {
    render(
      <ListPanel
        empty="Nothing here"
        getKey={(item) => item}
        items={["a", "b"]}
        label="Things"
        renderItem={(item) => <span>row-{item}</span>}
      />
    );
    expect(screen.getByText("row-a")).toBeTruthy();
    expect(screen.getByText("row-b")).toBeTruthy();
    expect(screen.queryByText("Nothing here")).toBeNull();
  });
});
