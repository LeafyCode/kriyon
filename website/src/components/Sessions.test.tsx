import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { Sessions } from "./Sessions.tsx";

const PRUNE_OLD_EVENT_LOGS = /Prune old event logs/;
test("the status line follows the picked session", () => {
  render(<Sessions />);
  expect(
    screen.getByText("WANTS TO RUN npm install · ANSWER IN ITS TERMINAL")
  ).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: PRUNE_OLD_EVENT_LOGS }));

  expect(screen.getByText("DELETED 2 FILES · src/legacy")).toBeTruthy();
});

const FLAKY = /Fix the flaky date test/;
test("sessions are grouped by project, a nested one under the session that asked", () => {
  const { container } = render(<Sessions />);
  const projects = [...container.querySelectorAll(".status-project")].map(
    (el) => el.textContent
  );
  expect(projects).toEqual(["orbit-web", "orbit-api"]);
  const nested = screen.getByRole("button", { name: FLAKY });
  expect(nested.getAttribute("data-nested")).toBe("true");
  expect(
    screen.getByText("4 SESSIONS · 2 PROJECTS", { exact: false })
  ).toBeTruthy();
});
