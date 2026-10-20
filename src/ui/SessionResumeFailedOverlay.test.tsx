import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { SessionResumeFailedOverlay } from "./SessionResumeFailedOverlay.tsx";

const COULDNT_RESUME = /couldn't resume/i;
const EXPIRED = /expired/i;
const START_FRESH = /start fresh/i;
const DISMISS = /dismiss/i;

test("explains the expired resume and offers start-fresh and dismiss", () => {
  render(
    <SessionResumeFailedOverlay onDismiss={vi.fn()} onStartFresh={vi.fn()} />
  );
  expect(screen.getByText(COULDNT_RESUME)).toBeTruthy();
  expect(screen.getByText(EXPIRED)).toBeTruthy();
  expect(screen.getByRole("button", { name: START_FRESH })).toBeTruthy();
  expect(screen.getByRole("button", { name: DISMISS })).toBeTruthy();
});

test("Start fresh calls onStartFresh", () => {
  const onStartFresh = vi.fn();
  render(
    <SessionResumeFailedOverlay
      onDismiss={vi.fn()}
      onStartFresh={onStartFresh}
    />
  );
  fireEvent.click(screen.getByRole("button", { name: START_FRESH }));
  expect(onStartFresh).toHaveBeenCalledTimes(1);
});

test("Dismiss calls onDismiss", () => {
  const onDismiss = vi.fn();
  render(
    <SessionResumeFailedOverlay onDismiss={onDismiss} onStartFresh={vi.fn()} />
  );
  fireEvent.click(screen.getByRole("button", { name: DISMISS }));
  expect(onDismiss).toHaveBeenCalledTimes(1);
});
