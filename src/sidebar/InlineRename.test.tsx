import { fireEvent, render } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { InlineRename } from "./InlineRename.tsx";

test("commits the trimmed text on blur and reverts on Escape", () => {
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  const { getByTestId, rerender } = render(
    <InlineRename
      ariaLabel="Rename"
      onCancel={onCancel}
      onCommit={onCommit}
      testId="edit"
      value="Old"
    />
  );
  const input = getByTestId("edit") as HTMLInputElement;

  fireEvent.change(input, { target: { value: "  New  " } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onCommit).toHaveBeenCalledWith("  New  ");

  // Escape arms the cancel flag so the ensuing blur does not also commit.
  rerender(
    <InlineRename
      ariaLabel="Rename"
      onCancel={onCancel}
      onCommit={onCommit}
      testId="edit"
      value="Old"
    />
  );
  onCommit.mockClear();
  fireEvent.change(input, { target: { value: "Discarded" } });
  fireEvent.keyDown(input, { key: "Escape" });
  expect(onCancel).toHaveBeenCalled();
  expect(onCommit).not.toHaveBeenCalled();
});

test("a re-render does not re-select the field mid-edit", () => {
  // Regression guard: focus/select must run only on mount. A parent re-render
  // (SessionRow ticks on live sessions) must not reset the caret/selection and
  // clobber the user's in-progress name on the next keystroke.
  const props = {
    ariaLabel: "Rename",
    onCancel: vi.fn(),
    onCommit: vi.fn(),
    testId: "edit",
    value: "Fix the bug",
  };
  const { getByTestId, rerender } = render(<InlineRename {...props} />);
  const input = getByTestId("edit") as HTMLInputElement;

  // The user has typed and the caret sits at the end (nothing selected).
  fireEvent.change(input, { target: { value: "Fix the bug now" } });
  input.setSelectionRange(input.value.length, input.value.length);

  // A routine parent re-render.
  rerender(<InlineRename {...props} />);

  // The field must be untouched — no re-select-all that a keystroke would wipe.
  expect(input.value).toBe("Fix the bug now");
  expect(input.selectionStart).toBe(input.value.length);
  expect(input.selectionEnd).toBe(input.value.length);
});
