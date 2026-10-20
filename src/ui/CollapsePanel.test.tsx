import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { CollapsePanel } from "./CollapsePanel.tsx";

function panel(): HTMLElement {
  return screen.getByTestId("panel");
}

test("renders its content at the open width", () => {
  render(
    <CollapsePanel open={true} side="left" testId="panel" width={278}>
      <div>content</div>
    </CollapsePanel>
  );

  expect(screen.getByText("content")).toBeInTheDocument();
  expect(panel().style.flexBasis).toBe("278px");
});

test("closing keeps content mounted until the slide ends, then swaps", () => {
  const { rerender } = render(
    <CollapsePanel
      closedWidth={46}
      collapsedChildren={<div>rail</div>}
      open={true}
      side="right"
      testId="panel"
      width={272}
    >
      <div>content</div>
    </CollapsePanel>
  );

  rerender(
    <CollapsePanel
      closedWidth={46}
      collapsedChildren={<div>rail</div>}
      open={false}
      side="right"
      testId="panel"
      width={272}
    >
      <div>content</div>
    </CollapsePanel>
  );

  // The wrapper is already heading to its closed width, but the content stays
  // mounted so it slides out instead of vanishing.
  expect(panel().style.flexBasis).toBe("46px");
  expect(screen.getByText("content")).toBeInTheDocument();
  expect(screen.queryByText("rail")).not.toBeInTheDocument();

  fireEvent.transitionEnd(panel());

  expect(screen.queryByText("content")).not.toBeInTheDocument();
  expect(screen.getByText("rail")).toBeInTheDocument();
});

test("a fully closed panel with no collapsed content renders nothing", () => {
  render(
    <CollapsePanel open={false} side="left" testId="panel" width={278}>
      <div>content</div>
    </CollapsePanel>
  );

  expect(screen.queryByText("content")).not.toBeInTheDocument();
  expect(panel().style.flexBasis).toBe("0px");
});

test("re-opening mounts the content immediately", () => {
  const { rerender } = render(
    <CollapsePanel open={false} side="left" testId="panel" width={278}>
      <div>content</div>
    </CollapsePanel>
  );

  rerender(
    <CollapsePanel open={true} side="left" testId="panel" width={278}>
      <div>content</div>
    </CollapsePanel>
  );

  expect(screen.getByText("content")).toBeInTheDocument();
  expect(panel().style.flexBasis).toBe("278px");
});

test("a width change while open resizes without animating", () => {
  const { rerender } = render(
    <CollapsePanel open={true} side="left" testId="panel" width={278}>
      <div>content</div>
    </CollapsePanel>
  );

  // No open/close toggle happened, so a drag-resize must not lag behind a
  // transition.
  expect(panel().style.transition).toBe("none");

  rerender(
    <CollapsePanel open={true} side="left" testId="panel" width={340}>
      <div>content</div>
    </CollapsePanel>
  );

  expect(panel().style.flexBasis).toBe("340px");
  expect(panel().style.transition).toBe("none");
});

test("a slide settles by timeout when transitionend never fires", () => {
  // Batched double-toggles and interrupted transitions can eat the
  // transitionend event; without a fallback the panel would stay stuck
  // showing clipped open-content at the closed width.
  vi.useFakeTimers();
  try {
    const { rerender } = render(
      <CollapsePanel
        closedWidth={46}
        collapsedChildren={<div>rail</div>}
        open={true}
        side="right"
        testId="panel"
        width={272}
      >
        <div>content</div>
      </CollapsePanel>
    );

    rerender(
      <CollapsePanel
        closedWidth={46}
        collapsedChildren={<div>rail</div>}
        open={false}
        side="right"
        testId="panel"
        width={272}
      >
        <div>content</div>
      </CollapsePanel>
    );

    expect(screen.getByText("content")).toBeInTheDocument();

    act(() => {
      vi.runAllTimers();
    });

    expect(screen.queryByText("content")).not.toBeInTheDocument();
    expect(screen.getByText("rail")).toBeInTheDocument();
    expect(panel().style.transition).toBe("none");
  } finally {
    vi.useRealTimers();
  }
});

test("a child transition ending mid-slide does not settle the panel", () => {
  const { rerender } = render(
    <CollapsePanel open={true} side="left" testId="panel" width={278}>
      <div data-testid="inner">content</div>
    </CollapsePanel>
  );

  rerender(
    <CollapsePanel open={false} side="left" testId="panel" width={278}>
      <div data-testid="inner">content</div>
    </CollapsePanel>
  );

  // A bubbled transitionend (e.g. a hover fade inside the panel) must not
  // unmount the sliding content or disarm the slide.
  fireEvent.transitionEnd(screen.getByTestId("inner"));

  expect(screen.getByText("content")).toBeInTheDocument();
  expect(panel().style.transition).toContain("flex-basis");
});

test("re-opening mid-slide keeps the content mounted throughout", () => {
  const { rerender } = render(
    <CollapsePanel open={true} side="left" testId="panel" width={278}>
      <div>content</div>
    </CollapsePanel>
  );

  // Close, then re-open before the slide settles (no transitionend between).
  rerender(
    <CollapsePanel open={false} side="left" testId="panel" width={278}>
      <div>content</div>
    </CollapsePanel>
  );
  rerender(
    <CollapsePanel open={true} side="left" testId="panel" width={278}>
      <div>content</div>
    </CollapsePanel>
  );

  expect(screen.getByText("content")).toBeInTheDocument();
  expect(panel().style.flexBasis).toBe("278px");

  // The reversed slide settles normally and the content stays.
  fireEvent.transitionEnd(panel());
  expect(screen.getByText("content")).toBeInTheDocument();
  expect(panel().style.transition).toBe("none");
});

test("toggling open enables the slide transition until it settles", () => {
  const { rerender } = render(
    <CollapsePanel open={true} side="left" testId="panel" width={278}>
      <div>content</div>
    </CollapsePanel>
  );

  rerender(
    <CollapsePanel open={false} side="left" testId="panel" width={278}>
      <div>content</div>
    </CollapsePanel>
  );

  expect(panel().style.transition).toContain("flex-basis");

  fireEvent.transitionEnd(panel());

  expect(panel().style.transition).toBe("none");
});
