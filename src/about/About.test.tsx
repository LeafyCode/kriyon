import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { About } from "./About.tsx";

const DISCLAIMER_RE =
  /not affiliated with, endorsed by, or sponsored by Anthropic/;
const TRADEMARK_RE = /Claude and Claude Code are trademarks of Anthropic, PBC/;
const OWN_INSTALL_RE = /runs your own, unmodified Claude Code install/;
const USAGE_LINE =
  "All sessions use your own Claude plan and its usage limits.";

test("renders nothing when closed", () => {
  render(<About onClose={() => undefined} open={false} />);
  expect(screen.queryByText(DISCLAIMER_RE)).toBeNull();
});

test("shows the name and disclaimer when open", () => {
  render(<About onClose={() => undefined} open={true} />);

  expect(screen.getByText("Kriyon")).toBeInTheDocument();
  expect(screen.getByText(DISCLAIMER_RE)).toBeInTheDocument();
});

test("the disclaimer names the trademarks and the user's own install", () => {
  render(<About onClose={() => undefined} open={true} />);

  const disclaimer = screen.getByText(DISCLAIMER_RE);
  expect(disclaimer).toHaveTextContent(TRADEMARK_RE);
  expect(disclaimer).toHaveTextContent(OWN_INSTALL_RE);
});

test("says every session spends the user's own plan", () => {
  render(<About onClose={() => undefined} open={true} />);

  expect(screen.getByText(USAGE_LINE)).toBeInTheDocument();
});

test("shows the version the app was built at, not a hardcoded one", () => {
  render(<About onClose={() => undefined} open={true} />);

  expect(screen.getByText(`Version ${__APP_VERSION__}`)).toBeInTheDocument();
});

test("Esc closes the about modal", () => {
  let closed = false;
  render(
    <About
      onClose={() => {
        closed = true;
      }}
      open={true}
    />
  );

  fireEvent.keyDown(window, { key: "Escape" });
  expect(closed).toBe(true);
});

test("clicking the backdrop closes the about modal", () => {
  let closed = false;
  render(
    <About
      onClose={() => {
        closed = true;
      }}
      open={true}
    />
  );

  fireEvent.click(screen.getByTestId("about-backdrop"));
  expect(closed).toBe(true);
});
