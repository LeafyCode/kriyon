import type { CSSProperties, ReactNode } from "react";
import { openExternalUrl } from "../ipc/bridge.ts";
import { isMacPlatform, thisComputer } from "../platform/os.ts";
import { useClaudeCli } from "../state/claudeCli.ts";
import { button, card } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import { copyText } from "../ui/copyText.ts";
import {
  actionsStyle,
  pageStyle,
  panelStyle,
  textStyle,
  titleStyle,
} from "./screenStyles.ts";

/**
 * The install screen of the [Claude CLI check], shown only when no `claude`
 * is on the PATH a new session gets. The steps are Claude Code's own
 * recommended native install (code.claude.com/docs/en/setup), for this
 * computer only.
 */

/** Claude Code's recommended install, per platform, as its docs give it. */
const INSTALL = {
  mac: {
    command: "curl -fsSL https://claude.ai/install.sh | bash",
    terminal: "Terminal",
  },
  windows: {
    command: "irm https://claude.ai/install.ps1 | iex",
    terminal: "PowerShell",
  },
};

const FIX_PATH_URL =
  "https://code.claude.com/docs/en/troubleshoot-install#command-not-found-claude-after-installation";
const GIT_FOR_WINDOWS_URL = "https://git-scm.com/downloads/win";

const stepStyle: CSSProperties = {
  ...card(),
  display: "flex",
  flexDirection: "column",
  gap: tokens.space.sm,
  padding: tokens.space.md,
};

const stepTitleStyle: CSSProperties = {
  color: tokens.color.ink.primary,
  fontSize: "13px",
  fontWeight: 600,
  margin: 0,
};

const commandRowStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: tokens.space.sm,
};

const commandStyle: CSSProperties = {
  background: tokens.color.chrome.window,
  borderRadius: tokens.radius.md,
  color: tokens.color.ink.bright,
  flex: 1,
  fontFamily: tokens.font.mono,
  fontSize: "12px",
  overflowX: "auto",
  padding: `${tokens.space.sm} ${tokens.space.md}`,
  whiteSpace: "nowrap",
};

const inlineCodeStyle: CSSProperties = {
  fontFamily: tokens.font.mono,
  fontSize: "12px",
};

const linkStyle: CSSProperties = {
  background: "none",
  border: "none",
  color: tokens.color.accent,
  cursor: "pointer",
  font: "inherit",
  padding: 0,
  textDecoration: "underline",
};

function Step({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section style={stepStyle}>
      <h2 style={stepTitleStyle}>{title}</h2>
      {children}
    </section>
  );
}

function Link({ children, url }: { children: ReactNode; url: string }) {
  return (
    <button
      className="kr-focusable"
      onClick={() => {
        openExternalUrl(url).catch(() => {
          // The browser didn't open; the page stays as it is.
        });
      }}
      style={linkStyle}
      type="button"
    >
      {children}
    </button>
  );
}

export function InstallClaudeScreen() {
  const checking = useClaudeCli((state) => state.checking);
  const check = useClaudeCli((state) => state.check);
  const skip = useClaudeCli((state) => state.skip);
  const mac = isMacPlatform();
  const install = mac ? INSTALL.mac : INSTALL.windows;

  return (
    <div data-testid="install-claude-screen" style={pageStyle}>
      <div
        aria-labelledby="install-claude-title"
        role="dialog"
        style={panelStyle}
      >
        <h1 id="install-claude-title" style={titleStyle}>
          Install Claude Code
        </h1>
        <p style={textStyle}>
          Kriyon runs your own Claude Code, and the{" "}
          <code style={inlineCodeStyle}>claude</code> command isn't on{" "}
          {thisComputer()} yet. Install it, then check again.
        </p>

        <Step title={`1. Open ${install.terminal} and run`}>
          <div style={commandRowStyle}>
            <code style={commandStyle}>{install.command}</code>
            <button
              className="kr-focusable kr-hover-surface"
              onClick={() => copyText(install.command, "command")}
              style={button("secondary")}
              type="button"
            >
              Copy
            </button>
          </div>
          <p style={textStyle}>
            It shows no progress while it downloads. When it finishes, open a
            new {install.terminal} window and run{" "}
            <code style={inlineCodeStyle}>claude --version</code>: a working
            install prints a version number.
          </p>
          {mac ? null : (
            <p style={textStyle}>
              <Link url={GIT_FOR_WINDOWS_URL}>Git for Windows</Link> is
              recommended, so Claude Code can use its Bash tool.
            </p>
          )}
        </Step>

        <Step title="2. Sign in">
          <p style={textStyle}>
            Your first Kriyon session starts{" "}
            <code style={inlineCodeStyle}>claude</code>, which opens your
            browser to log in. Claude Code needs a Pro, Max, Team, Enterprise or
            Console account.
          </p>
        </Step>

        <p style={textStyle}>
          Installed, but <code style={inlineCodeStyle}>claude</code> still isn't
          found? <Link url={FIX_PATH_URL}>Fix your PATH</Link>.
        </p>

        <div style={actionsStyle}>
          <button
            className="kr-focusable kr-hover-surface"
            onClick={skip}
            style={button("secondary")}
            type="button"
          >
            Continue anyway
          </button>
          <button
            className="kr-focusable kr-hover-accent"
            disabled={checking}
            onClick={() => {
              check().catch(() => {
                // The store records a failed check as unknown.
              });
            }}
            style={button("primary")}
            type="button"
          >
            {checking ? "Checking…" : "Check again"}
          </button>
        </div>
      </div>
    </div>
  );
}
