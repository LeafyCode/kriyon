import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { SessionLoadingOverlay } from "./SessionLoadingOverlay.tsx";

test("shows the resuming copy when resuming", () => {
  render(<SessionLoadingOverlay resuming={true} />);
  expect(screen.getByTestId("session-loading-overlay")).toBeInTheDocument();
  expect(screen.getByText("Resuming session…")).toBeInTheDocument();
});

test("shows the starting copy for a fresh launch", () => {
  render(<SessionLoadingOverlay resuming={false} />);
  expect(screen.getByText("Starting Claude…")).toBeInTheDocument();
});
