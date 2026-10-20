import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { Sessions } from "./Sessions.tsx";

const PRUNE_OLD_EVENT_LOGS = /Prune old event logs/;
test("the status line follows the picked session", () => {
  render(<Sessions />);
  expect(screen.getByText("WANTS TO RUN npm install")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: PRUNE_OLD_EVENT_LOGS }));

  expect(screen.getByText("DELETED 2 FILES · src/legacy")).toBeTruthy();
});
