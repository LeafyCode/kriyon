import { useCallback, useEffect, useRef } from "react";
import { useReducedMotion } from "../lib/motion.ts";
import { useOnceVisible } from "../lib/useOnceVisible.ts";

/** Draws the branch/merge diagram (stroke dash + dot fade) when scrolled into view. */
function useTreeDraw(panelRef: React.RefObject<HTMLDivElement | null>) {
  const rafRef = useRef(0);
  const reducedMotion = useReducedMotion();
  const draw = useCallback(() => {
    const panel = panelRef.current;
    if (!panel || reducedMotion) {
      return;
    }
    const paths = Array.from(
      panel.querySelectorAll<SVGPathElement>("[data-draw]")
    );
    for (const [i, path] of paths.entries()) {
      const length = path.getTotalLength();
      path.style.strokeDasharray = `${length}`;
      path.style.strokeDashoffset = `${length}`;
      path.style.transition = `stroke-dashoffset 1.3s ease ${i * 0.45}s`;
    }
    const dots = Array.from(
      panel.querySelectorAll<SVGCircleElement>("[data-dot]")
    );
    for (const [i, dot] of dots.entries()) {
      dot.style.opacity = "0";
      dot.style.transition = `opacity 0.4s ease ${0.35 + i * 0.32}s`;
    }
    // Two frames: the first commits the dash offsets, the second starts the
    // transition from them. Tracked so a fast unmount can't write to detached
    // nodes.
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = requestAnimationFrame(() => {
        for (const path of paths) {
          path.style.strokeDashoffset = "0";
        }
        for (const dot of dots) {
          dot.style.opacity = "1";
        }
      });
    });
  }, [panelRef, reducedMotion]);

  useOnceVisible(panelRef, draw);
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);
}

export function SceneWorktrees() {
  const panelRef = useRef<HTMLDivElement>(null);
  useTreeDraw(panelRef);

  return (
    <div className="scene-split">
      <div>
        <p className="eyebrow" data-reveal={0}>
          SCENE 05 · WORKTREES & MERGE
        </p>
        <h2 data-reveal={1}>
          Parallel work that{" "}
          <span className="gradient-text-short">never collides.</span>
        </h2>
        <p className="scene-split-copy" data-reveal={2}>
          Give each session its own branch and working copy. Kriyon sets the
          worktree up — copies your <span className="inline-code">.env</span>{" "}
          files, runs the right install, then your setup command. Review the
          diff since fork and merge back with one click. Conflicts are surfaced,
          never auto-resolved.
        </p>
        <p className="scene-meta" data-reveal={3}>
          ISOLATED WORKTREES · AUTO-SETUP · ONE-CLICK MERGE
        </p>
      </div>
      <div className="worktree-panel" data-reveal={1} ref={panelRef}>
        <svg role="img" viewBox="0 0 480 170">
          <title>feat/offline-retry branches from main and merges back</title>
          <path
            d="M 20 130 L 460 130"
            data-draw
            fill="none"
            stroke="rgba(168,190,255,0.4)"
            strokeLinecap="round"
            strokeWidth="2.5"
          />
          <path
            d="M 90 130 C 130 130 130 50 170 50 L 330 50 C 372 50 372 130 412 130"
            data-draw
            fill="none"
            stroke="var(--acc)"
            strokeLinecap="round"
            strokeWidth="2.5"
          />
          <circle
            cx="90"
            cy="130"
            data-dot
            fill="#05060b"
            r="5.5"
            stroke="rgba(168,190,255,0.6)"
            strokeWidth="2.5"
          />
          <circle
            cx="210"
            cy="50"
            data-dot
            fill="#05060b"
            r="5.5"
            stroke="var(--acc)"
            strokeWidth="2.5"
          />
          <circle
            cx="270"
            cy="50"
            data-dot
            fill="#05060b"
            r="5.5"
            stroke="var(--acc)"
            strokeWidth="2.5"
          />
          <circle
            cx="330"
            cy="50"
            data-dot
            fill="#05060b"
            r="5.5"
            stroke="var(--acc)"
            strokeWidth="2.5"
          />
          <circle cx="412" cy="130" data-dot fill="var(--acc)" r="6.5" />
          <text
            fill="rgba(226,232,255,0.5)"
            fontFamily="JetBrains Mono Variable, monospace"
            fontSize="11"
            x="24"
            y="152"
          >
            main
          </text>
          <text
            fill="var(--lav)"
            fontFamily="JetBrains Mono Variable, monospace"
            fontSize="11"
            x="168"
            y="32"
          >
            feat/offline-retry
          </text>
          <text
            fill="rgba(226,232,255,0.7)"
            fontFamily="JetBrains Mono Variable, monospace"
            fontSize="11"
            x="392"
            y="158"
          >
            merged
          </text>
        </svg>
        <div className="worktree-merge-row">
          <span className="worktree-merge-label">
            feat/offline-retry → main · <span className="diff-add">+226</span>{" "}
            <span className="diff-del">−31</span>
          </span>
          <span className="worktree-merge-button">MERGE INTO MAIN</span>
        </div>
      </div>
    </div>
  );
}
