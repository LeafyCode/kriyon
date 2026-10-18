import type { CSSProperties } from "react";
import appIcon from "../assets/app-icon.svg";
import { openExternalUrl } from "../ipc/bridge.ts";
import { overlayPanel } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import { Overlay } from "../ui/Overlay.tsx";

export interface AboutProps {
  onClose: () => void;
  open: boolean;
}

const APP_VERSION = __APP_VERSION__;
const DESCRIPTION = "A desktop GUI that works with the Claude Code CLI.";
const COMPANY = "Leafy Code International (Pvt) Ltd";
const COMPANY_URL = "https://leafycode.com/";
const USAGE_LINE =
  "All sessions use your own Claude plan and its usage limits.";
const DISCLAIMER =
  "Kriyon is an independent open-source project. It is not affiliated with, endorsed by, or sponsored by Anthropic. Claude and Claude Code are trademarks of Anthropic, PBC. Kriyon runs your own, unmodified Claude Code install; you sign in through Anthropic's own flow and your use is governed by your agreement with Anthropic.";

const panelStyle: CSSProperties = {
  ...overlayPanel(),
  gap: tokens.space.sm,
  maxWidth: "420px",
  padding: tokens.space.xl,
  width: "420px",
};

const logoStyle: CSSProperties = {
  borderRadius: tokens.radius.lg,
  boxShadow: tokens.shadow.raised,
};

const nameStyle: CSSProperties = {
  color: tokens.color.ink.bright,
  fontSize: "16px",
  fontWeight: 700,
};

const descriptionStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "12.5px",
};

const versionStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontFamily: tokens.font.mono,
  fontSize: "11px",
};

const creditStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "12px",
  marginTop: tokens.space.xs,
};

const companyLinkStyle: CSSProperties = {
  background: "none",
  border: "none",
  color: tokens.color.accentBright,
  cursor: "pointer",
  font: "inherit",
  padding: 0,
  textDecoration: "underline",
};

const disclaimerStyle: CSSProperties = {
  borderTop: `1px solid ${tokens.color.line.base}`,
  color: tokens.color.ink.muted,
  fontSize: "11.5px",
  lineHeight: 1.55,
  marginTop: tokens.space.sm,
  paddingTop: tokens.space.md,
};

export function About({ onClose, open }: AboutProps) {
  if (!open) {
    return null;
  }

  return (
    <Overlay
      align="center"
      backdropTestId="about-backdrop"
      label="Close about"
      onClose={onClose}
    >
      <section aria-label="About Kriyon" style={panelStyle}>
        <img alt="" height={64} src={appIcon} style={logoStyle} width={64} />
        <span style={nameStyle}>Kriyon</span>
        <span style={descriptionStyle}>{DESCRIPTION}</span>
        <span style={descriptionStyle}>{USAGE_LINE}</span>
        <span style={versionStyle}>Version {APP_VERSION}</span>
        <span style={creditStyle}>
          A product of{" "}
          <button
            onClick={() => openExternalUrl(COMPANY_URL)}
            style={companyLinkStyle}
            type="button"
          >
            {COMPANY}
          </button>
        </span>
        <p style={disclaimerStyle}>{DISCLAIMER}</p>
      </section>
    </Overlay>
  );
}
