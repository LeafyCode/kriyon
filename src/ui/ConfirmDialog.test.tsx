import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

function open(details?: string[]) {
  render(
    <ConfirmDialog
      body="Quitting stops 2 running commands:"
      confirmLabel="Stop and quit"
      details={details}
      label="Cancel quitting"
      onCancel={vi.fn()}
      onConfirm={vi.fn()}
      title="Quit and stop these?"
    />
  );
}

describe("ConfirmDialog details", () => {
  it("lists every command a stop would end", () => {
    open(["pnpm dev", "cargo watch"]);
    const items = screen.getByTestId("confirm-details").querySelectorAll("li");
    expect(items).toHaveLength(2);
  });

  // Two sessions running the identical command is ordinary, and so is the
  // capped list repeating a line. Keying the row by its text made those
  // duplicate React keys: a warning, and a list React reconciles unreliably.
  it("renders duplicate command lines as separate rows", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {
      // Swallowed: the assertion below is that nothing was logged.
    });
    open(["pnpm dev", "pnpm dev"]);

    const items = screen.getByTestId("confirm-details").querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("shows no list at all when a stop would end nothing", () => {
    open([]);
    expect(screen.queryByTestId("confirm-details")).toBeNull();
  });
});
