/**
 * The [Step detail] dialog: one [Activity step] in full — its redacted
 * input, the result preview, what allowed it, timing and agent — plus "Open
 * in Changes" for an edit or write.
 */
import { type CSSProperties, type ReactNode, useId } from "react";
import type { ActivityStep } from "../../ipc/bridge.ts";
import { button, overlayPanel, sectionLabel } from "../../theme/recipes.ts";
import { tokens } from "../../theme/tokens.ts";
import { Overlay } from "../../ui/Overlay.tsx";
import { durationLabel } from "../activity/toolLabel.ts";
import {
  agentLabel,
  clockLabel,
  prettyInput,
  prettyResult,
  stepLabel,
} from "./activityLog.ts";
import { useStepDetail } from "./useActivityLog.ts";

const panelStyle: CSSProperties = {
  ...overlayPanel(),
  gap: tokens.space.md,
  maxHeight: "76vh",
  overflowY: "auto",
  padding: "18px",
  width: "min(560px, 90vw)",
};

const titleStyle: CSSProperties = {
  color: tokens.color.ink.bright,
  fontSize: "14px",
  fontWeight: 700,
  margin: 0,
};

const targetStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontFamily: tokens.font.mono,
  fontSize: "11.5px",
  margin: "4px 0 0",
  overflowWrap: "anywhere",
};

const factsStyle: CSSProperties = {
  columnGap: tokens.space.md,
  display: "grid",
  fontSize: "12.5px",
  gridTemplateColumns: "auto 1fr",
  margin: 0,
  rowGap: "6px",
};

const factLabelStyle: CSSProperties = { color: tokens.color.ink.muted };

const factValueStyle: CSSProperties = {
  color: tokens.color.ink.primary,
  margin: 0,
};

const blockLabelStyle: CSSProperties = {
  ...sectionLabel(),
  display: "block",
  paddingBottom: "6px",
};

const codeStyle: CSSProperties = {
  background: tokens.color.blockWell,
  border: `1px solid ${tokens.color.line.base}`,
  borderRadius: tokens.radius.md,
  color: tokens.color.ink.secondary,
  fontFamily: tokens.font.mono,
  fontSize: "11px",
  margin: 0,
  maxHeight: "220px",
  overflow: "auto",
  padding: "8px 10px",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const quietStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "12.5px",
  margin: 0,
};

const actionsStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: tokens.space.sm,
  justifyContent: "flex-end",
};

const reasonStyle: CSSProperties = {
  ...quietStyle,
  flex: 1,
  fontSize: "12px",
};

function Block({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <span style={blockLabelStyle}>{label}</span>
      {text ? (
        <pre style={codeStyle}>{text}</pre>
      ) : (
        <p style={quietStyle}>Nothing recorded.</p>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <>
      <dt style={factLabelStyle}>{label}</dt>
      <dd style={factValueStyle}>{value}</dd>
    </>
  );
}

function DetailBody({
  sessionId,
  step,
}: {
  sessionId: string;
  step: ActivityStep;
}) {
  const view = useStepDetail(sessionId, step.id);
  if (view.state === "loading") {
    return <p style={quietStyle}>Loading…</p>;
  }
  if (view.state === "gone") {
    return <p style={quietStyle}>This step is no longer in the log.</p>;
  }
  if (view.state === "error") {
    return <p style={quietStyle}>Couldn't read this step: {view.message}</p>;
  }
  const { detail } = view;
  return (
    <>
      <dl style={factsStyle}>
        <Fact label="When" value={clockLabel(detail.startedMs, Date.now())} />
        <Fact
          label="Took"
          value={
            detail.durationMs === null
              ? "Still running"
              : durationLabel(detail.durationMs)
          }
        />
        <Fact label="Agent" value={agentLabel(detail.agentType)} />
        <Fact label="Allowed by" value={detail.allowedBy} />
        <Fact label="Tool" value={detail.toolName} />
      </dl>
      <Block label="Input" text={prettyInput(detail.input)} />
      <Block label="Result" text={prettyResult(detail.result)} />
    </>
  );
}

export function StepDetailDialog({
  onClose,
  onOpenInChanges,
  sessionId,
  step,
  unavailableReason,
}: {
  onClose: () => void;
  /** Opens the step's file in the Changes view; `null` when it can't. */
  onOpenInChanges: (() => void) | null;
  sessionId: string;
  step: ActivityStep;
  /** Why an edit or write can't open in the Changes view, said in place of the button. */
  unavailableReason: string | null;
}) {
  const titleId = useId();
  return (
    <Overlay label="Close step detail" onClose={onClose}>
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        role="dialog"
        style={panelStyle}
      >
        <div>
          <p id={titleId} style={titleStyle}>
            {stepLabel(step)}
          </p>
          {step.target ? <p style={targetStyle}>{step.target}</p> : null}
        </div>
        <DetailBody sessionId={sessionId} step={step} />
        <div style={actionsStyle}>
          {unavailableReason ? (
            <p style={reasonStyle}>{unavailableReason}</p>
          ) : null}
          {onOpenInChanges ? (
            <button
              className="kr-hover-surface"
              onClick={onOpenInChanges}
              style={button("secondary")}
              type="button"
            >
              Open in Changes
            </button>
          ) : null}
          <button
            className="kr-hover-surface"
            onClick={onClose}
            style={button("secondary")}
            type="button"
          >
            Close
          </button>
        </div>
      </div>
    </Overlay>
  );
}
