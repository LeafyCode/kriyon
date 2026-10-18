import { ShotImage } from "./ShotImage.tsx";

const SHORTCUTS = [
  { chord: "⌘K", label: "palette" },
  { chord: "⌘⇧K", label: "needs you" },
  { chord: "⌘⇧P", label: "prompts" },
  { chord: "⌘N", label: "new session" },
  { chord: "⌘D", label: "split terminal" },
  { chord: "⌘S", label: "save in Changes" },
];

export function SceneMenuBar() {
  return (
    <div className="scene-split">
      <div>
        <p className="eyebrow" data-reveal={0}>
          SCENE 04 · MENU BAR & NOTIFICATIONS
        </p>
        <h2 data-reveal={1}>
          Close the window.{" "}
          <span className="gradient-text-short">Stay in the loop.</span>
        </h2>
        <p className="scene-split-copy" data-reveal={2}>
          A glance at the menu bar shows what needs you and what's still running
          — even with Kriyon closed. Notifications name the session, quote the
          actual ask, and are withdrawn the moment they stop being true. Click
          one to land in the right terminal.
        </p>
        <div className="shortcut-chips" data-reveal={3}>
          {SHORTCUTS.map(({ chord, label }) => (
            <span key={chord}>
              <b>{chord}</b> {label}
            </span>
          ))}
        </div>
      </div>
      <div className="menu-bar-visual" data-reveal={1}>
        <div className="menu-bar-glow" />
        <div className="menu-bar-shot">
          <ShotImage
            alt="Menu bar quick view — sessions needing you at a glance"
            fetchPriority="low"
            name="05-menu-bar-triage-portrait"
            sizes="(max-width: 880px) 60vw, 22vw"
          />
        </div>
      </div>
    </div>
  );
}
