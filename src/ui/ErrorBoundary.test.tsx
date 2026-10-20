import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary.tsx";

// A plain "throws on its first render" flag is unreliable here: React's
// concurrent root replays a failed render synchronously before handing the
// error to the boundary, and flipping the flag as a side effect of the throw
// itself makes the outcome depend on how many hidden replay passes React
// happens to run. Flipping it explicitly, from the test, between the two
// user-visible steps (initial mount vs. clicking "Try again") keeps every
// render pass in a given step consistent, however many of them React runs.
let broken = true;

function FlakyChild() {
  if (broken) {
    throw new Error("boom");
  }
  return <div>recovered</div>;
}

test("Try again clears the caught error and remounts the subtree", () => {
  broken = true;
  render(
    <ErrorBoundary label="This panel hit an error.">
      <FlakyChild />
    </ErrorBoundary>
  );
  expect(screen.getByText("This panel hit an error.")).toBeInTheDocument();
  expect(screen.getByText("boom")).toBeInTheDocument();

  broken = false;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));

  expect(screen.getByText("recovered")).toBeInTheDocument();
  expect(
    screen.queryByText("This panel hit an error.")
  ).not.toBeInTheDocument();
});
