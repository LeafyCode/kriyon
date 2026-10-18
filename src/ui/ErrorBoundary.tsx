import { Component, type ErrorInfo, type ReactNode } from "react";
import { button } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";

interface Props {
  children: ReactNode;
  /** Shown in place of the subtree when it throws. */
  label?: string;
}

interface State {
  message: string | null;
}

const fallbackStyle = {
  alignItems: "center",
  color: tokens.color.ink.muted,
  display: "flex",
  flexDirection: "column",
  fontFamily: tokens.font.sans,
  fontSize: "13px",
  gap: tokens.space.sm,
  height: "100%",
  justifyContent: "center",
  padding: tokens.space.xl,
  textAlign: "center",
} as const;

const detailStyle = {
  color: tokens.color.ink.faint,
  fontFamily: tokens.font.mono,
  fontSize: "11px",
  maxWidth: "46ch",
  overflowWrap: "anywhere",
} as const;

const retryButtonStyle = button("secondary");

/**
 * Contains render-time crashes to a single panel. Before this existed, a throw
 * in any one panel (e.g. the terminal addon) blanked the entire window — the
 * exact white-screen failure that motivated it.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { message: null };

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to the dev console without taking down the rest of the UI.
    // biome-ignore lint/suspicious/noConsole: a contained crash is worth logging.
    console.error("Panel crashed:", error, info.componentStack);
  }

  // Clears the caught error so `render` falls back to `this.props.children`
  // again, which remounts the subtree — the only way out of a caught error
  // React itself offers (there is no "un-catch"), and the fallback's own dead
  // end otherwise: a panel that throws once was stuck showing the error
  // forever, even after whatever caused it (a stale prop, a transient race)
  // resolved.
  reset = (): void => {
    this.setState({ message: null });
  };

  render(): ReactNode {
    if (this.state.message !== null) {
      return (
        <div style={fallbackStyle}>
          <span>{this.props.label ?? "This panel hit an error."}</span>
          <span style={detailStyle}>{this.state.message}</span>
          <button
            className="kr-hover-surface"
            onClick={this.reset}
            style={retryButtonStyle}
            type="button"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
