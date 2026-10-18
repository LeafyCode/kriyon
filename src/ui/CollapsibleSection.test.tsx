import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { CollapsibleSection } from "./CollapsibleSection.tsx";

const CHANGES_HEADER = /changes/i;

test("hides the body when closed but keeps it mounted", () => {
  const { rerender } = render(
    <CollapsibleSection onToggle={vi.fn()} open testId="cs" title="Changes">
      <p>x</p>
    </CollapsibleSection>
  );
  expect(screen.getByText("x")).toBeVisible();

  rerender(
    <CollapsibleSection
      onToggle={vi.fn()}
      open={false}
      testId="cs"
      title="Changes"
    >
      <p>x</p>
    </CollapsibleSection>
  );
  // Still in the DOM, just display:none — never unmounted (repo rule: a
  // remount would blank a terminal / lose a virtualizer's scroll position).
  expect(screen.getByText("x")).not.toBeVisible();
  expect(screen.getByText("x")).toBeInTheDocument();
});

test("fires onToggle when the header is clicked", () => {
  const onToggle = vi.fn();
  render(
    <CollapsibleSection onToggle={onToggle} open testId="cs" title="Changes">
      <p>x</p>
    </CollapsibleSection>
  );
  fireEvent.click(screen.getByRole("button", { name: CHANGES_HEADER }));
  expect(onToggle).toHaveBeenCalledWith(false);
});

test("the header button reflects open state via aria-expanded", () => {
  const { rerender } = render(
    <CollapsibleSection onToggle={vi.fn()} open testId="cs" title="Changes">
      <p>x</p>
    </CollapsibleSection>
  );
  expect(screen.getByRole("button", { name: CHANGES_HEADER })).toHaveAttribute(
    "aria-expanded",
    "true"
  );

  rerender(
    <CollapsibleSection
      onToggle={vi.fn()}
      open={false}
      testId="cs"
      title="Changes"
    >
      <p>x</p>
    </CollapsibleSection>
  );
  expect(screen.getByRole("button", { name: CHANGES_HEADER })).toHaveAttribute(
    "aria-expanded",
    "false"
  );
});

test("renders an always-visible headerRight slot regardless of open state", () => {
  const { rerender } = render(
    <CollapsibleSection
      headerRight={<span>+3 -1</span>}
      onToggle={vi.fn()}
      open
      testId="cs"
      title="Changes"
    >
      <p>x</p>
    </CollapsibleSection>
  );
  expect(screen.getByText("+3 -1")).toBeVisible();

  rerender(
    <CollapsibleSection
      headerRight={<span>+3 -1</span>}
      onToggle={vi.fn()}
      open={false}
      testId="cs"
      title="Changes"
    >
      <p>x</p>
    </CollapsibleSection>
  );
  expect(screen.getByText("+3 -1")).toBeVisible();
});
