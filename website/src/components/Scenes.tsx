import type { ReactNode } from "react";
import type { ShotName } from "../lib/shots.ts";
import { CountUp } from "./CountUp.tsx";
import { SceneMenuBar } from "./SceneMenuBar.tsx";
import { SceneWorktrees } from "./SceneWorktrees.tsx";
import { ShotImage } from "./ShotImage.tsx";

interface SceneShotProps {
  alt: string;
  body: ReactNode;
  img: ShotName;
  label: string;
  meta: ReactNode;
  tilt: "left" | "right";
  title: ReactNode;
}

/** Scenes 01–03 share this layout: heading row, copy, tilted screenshot. */
function SceneShot({
  label,
  title,
  body,
  meta,
  img,
  alt,
  tilt,
}: SceneShotProps) {
  return (
    <div>
      <p className="eyebrow" data-reveal={0}>
        {label}
      </p>
      <div className="scene-head">
        <h2 data-reveal={1}>{title}</h2>
        <div className="scene-body" data-reveal={2}>
          <p>{body}</p>
          <p className="scene-meta">{meta}</p>
        </div>
      </div>
      <div className="scene-shot-wrap" data-reveal={3}>
        <div className={`scene-shot scene-shot-${tilt}`}>
          {/* Chrome's lazy-load threshold reaches the first of these during the
              initial load; `fetchPriority="low"` keeps it from competing with
              the hero for bandwidth when it does. */}
          <ShotImage
            alt={alt}
            fetchPriority="low"
            name={img}
            sizes="(max-width: 880px) 100vw, 78vw"
          />
        </div>
      </div>
    </div>
  );
}

export function Scenes() {
  return (
    <section className="scenes" id="scenes">
      <SceneShot
        alt="Changes view — syntax-highlighted diffs with file tree"
        body={
          <>
            Each session diffs against its own private snapshot — two sessions
            on the same checkout never show each other's work. Edits by any
            means are caught: a <span className="inline-code">sed</span>, a
            formatter, a script. Edit and save files in place, or open them in
            your own editor.
          </>
        }
        img="01-changes-review"
        label="SCENE 01 · CHANGES VIEW"
        meta={
          <>
            LIVE DIFFS ·{" "}
            <span className="diff-add">+{<CountUp to={226} />}</span>{" "}
            <span className="diff-del">−{<CountUp to={31} />}</span> ·
            PER-SESSION SNAPSHOTS · ⌘S
          </>
        }
        tilt="left"
        title={
          <>
            See what changed.{" "}
            <span className="gradient-text-short">Nothing else.</span>
          </>
        }
      />

      <SceneShot
        alt="Command palette — jump to any session or run any action"
        body={
          <>
            ⌘K jumps to any session or runs any action — new worktree session,
            review changed files, switch layout. In the composer,{" "}
            <span className="inline-code">/</span> lists your real slash
            commands and <span className="inline-code">@</span> mentions project
            files, respecting .gitignore.
          </>
        }
        img="03-command-palette"
        label="SCENE 02 · COMMAND PALETTE"
        meta="⌘K PALETTE · / COMMANDS · @ FILES · COLORED CHIPS"
        tilt="right"
        title={
          <>
            Every session,{" "}
            <span className="gradient-text-short">one keystroke</span> away.
          </>
        }
      />

      <SceneShot
        alt="Prompt library — searchable picker with placeholders"
        body={
          <>
            Save the prompts that work — with{" "}
            <span className="inline-code">{"{name}"}</span> slots you fill at
            insert time and <span className="inline-code">{"{clipboard}"}</span>{" "}
            that fills itself. Summon with ⌘⇧P, preview, insert — nothing ever
            sends itself. Promote a favourite into a real{" "}
            <span className="inline-code">/command</span>.
          </>
        }
        img="04-prompt-library"
        label="SCENE 03 · PROMPT LIBRARY"
        meta="⌘⇧P PICKER · PLACEHOLDERS · TAGS & FAVOURITES"
        tilt="left"
        title={
          <>
            Your best prompts,{" "}
            <span className="gradient-text-short">on tap.</span>
          </>
        }
      />

      <SceneMenuBar />
      <SceneWorktrees />
    </section>
  );
}
