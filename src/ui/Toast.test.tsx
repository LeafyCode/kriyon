import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { showToast, Toast } from "./Toast.tsx";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("defaults to a success toast: check glyph, done ink, status role", () => {
  render(<Toast />);

  act(() => showToast("Saved"));

  const toast = screen.getByRole("status");
  expect(toast).toHaveTextContent("✓Saved");
});

test("an error toast gets a distinct glyph and role=alert", () => {
  render(<Toast />);

  act(() => showToast("Could not save", "error"));

  const toast = screen.getByRole("alert");
  expect(toast).toHaveTextContent("✕Could not save");
});

test("a success toast auto-dismisses at 1500ms", () => {
  render(<Toast />);
  act(() => showToast("Saved"));
  expect(screen.getByRole("status")).toBeInTheDocument();

  act(() => vi.advanceTimersByTime(1500));

  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

test("an error toast stays up longer than a success toast (~5000ms)", () => {
  render(<Toast />);
  act(() => showToast("Could not save", "error"));

  act(() => vi.advanceTimersByTime(1500));
  expect(screen.getByRole("alert")).toBeInTheDocument();

  act(() => vi.advanceTimersByTime(3500));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("a later toast replaces an earlier one still showing", () => {
  render(<Toast />);
  act(() => showToast("First"));
  act(() => showToast("Second"));

  const toasts = screen.getAllByRole("status");
  expect(toasts).toHaveLength(1);
  expect(toasts[0]).toHaveTextContent("Second");
});
