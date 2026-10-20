import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { PromptRowActions } from "./PromptRowActions.tsx";

function setup(
  over: Partial<Parameters<typeof PromptRowActions>[0]> = {}
): Parameters<typeof PromptRowActions>[0] {
  const props = {
    deleteArmed: false,
    favourite: false,
    insertDisabled: false,
    onDelete: vi.fn(),
    onEdit: vi.fn(),
    onInsert: vi.fn(),
    onToggleFavourite: vi.fn(),
    ...over,
  };
  render(<PromptRowActions {...props} />);
  return props;
}

test("each button invokes its callback", () => {
  const props = setup();
  fireEvent.click(screen.getByLabelText("Insert prompt"));
  fireEvent.click(screen.getByLabelText("Favourite"));
  fireEvent.click(screen.getByLabelText("Edit prompt"));
  fireEvent.click(screen.getByLabelText("Delete prompt"));
  expect(props.onInsert).toHaveBeenCalledTimes(1);
  expect(props.onToggleFavourite).toHaveBeenCalledTimes(1);
  expect(props.onEdit).toHaveBeenCalledTimes(1);
  expect(props.onDelete).toHaveBeenCalledTimes(1);
});

test("favourite state flips the star affordance", () => {
  setup({ favourite: true });
  expect(screen.getByLabelText("Unfavourite")).toHaveTextContent("★");
});

test("armed delete shows the confirm affordance", () => {
  setup({ deleteArmed: true });
  expect(screen.getByLabelText("Confirm delete")).toBeInTheDocument();
});

test("insert is disabled when insertDisabled", () => {
  const props = setup({ insertDisabled: true });
  const btn = screen.getByLabelText("Insert prompt");
  expect(btn).toBeDisabled();
  fireEvent.click(btn);
  expect(props.onInsert).not.toHaveBeenCalled();
});
