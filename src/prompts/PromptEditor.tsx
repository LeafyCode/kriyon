import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import { promotePromptToCommand } from "../ipc/bridge.ts";
import { usePromptLibrary } from "../state/promptLibrary.ts";
import { useSessions } from "../state/sessions.ts";
import { type PromptEditorSeed, useUi } from "../state/ui.ts";
import { button, inputBox, overlayPanel } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import type { SavedPrompt } from "../types.ts";
import { Overlay } from "../ui/Overlay.tsx";
import { showToast } from "../ui/Toast.tsx";

const panelStyle: CSSProperties = {
  ...overlayPanel(),
  gap: tokens.space.sm,
  maxHeight: "72vh",
  overflow: "auto",
  padding: tokens.space.lg,
  width: "min(560px, 92vw)",
};

/** The single-line fields are the input *well*, not a card. */
const titleFieldStyle: CSSProperties = {
  ...inputBox(),
  color: tokens.color.ink.bright,
  display: "block",
  fontFamily: tokens.font.sans,
  fontSize: "12.5px",
  outline: "none",
};

const bodyFieldStyle: CSSProperties = {
  ...inputBox(),
  color: tokens.color.ink.bright,
  display: "block",
  fontFamily: tokens.font.mono,
  fontSize: "12.5px",
  height: "auto",
  lineHeight: 1.5,
  outline: "none",
  padding: tokens.space.sm,
  resize: "vertical",
};

const tagsFieldStyle: CSSProperties = {
  ...titleFieldStyle,
  fontFamily: tokens.font.mono,
};

const selectStyle: CSSProperties = {
  ...inputBox(),
  color: tokens.color.ink.secondary,
  display: "inline-block",
  fontFamily: tokens.font.sans,
  fontSize: "12.5px",
  outline: "none",
};

const actionsStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: tokens.space.sm,
  justifyContent: "flex-end",
  marginTop: tokens.space.xs,
};

const secondaryStyle: CSSProperties = button("secondary");

const dangerStyle: CSSProperties = {
  ...button("danger"),
  marginRight: "auto",
};

const primaryStyle: CSSProperties = button("primary");

/** `"Review the Diff!"` → `"review-the-diff"`, falling back to `"prompt"`. */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug.length > 0 ? slug : "prompt";
}

/** Comma-separated tags → trimmed, deduped, order-preserving list. */
function splitTags(text: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of text.split(",")) {
    const tag = raw.trim();
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
  }
  return tags;
}

/**
 * The [Prompt editor] dialog: create/edit a [Saved prompt], delete it (armed
 * two-click, no `window.confirm`), or [Promote] it to a `.claude/commands/`
 * slash command. Mounted globally; opened via {@link useUi}'s
 * `openPromptEditor`. Field state remounts per-seed via a `key` on the inner
 * form so a different prompt opening never shows stale fields.
 */
export function PromptEditor() {
  const seed = useUi((s) => s.promptEditorSeed);
  const close = useUi((s) => s.closePromptEditor);

  if (!seed) {
    return null;
  }

  return <PromptEditorForm close={close} key={seed.id ?? "new"} seed={seed} />;
}

function PromptEditorForm({
  close,
  seed,
}: {
  close: () => void;
  seed: PromptEditorSeed;
}) {
  const save = usePromptLibrary((s) => s.save);
  const remove = usePromptLibrary((s) => s.remove);
  const activeProject = useSessions((s) => {
    const session = s.activeSessionId ? s.sessions[s.activeSessionId] : null;
    return session
      ? (s.projects.find((p) => p.id === session.projectId) ?? null)
      : null;
  });

  const [title, setTitle] = useState(seed.title);
  const [body, setBody] = useState(seed.body);
  const [tagsText, setTagsText] = useState(seed.tags.join(", "));
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [scope, setScope] = useState<"global" | "project">("global");
  const [promoteArmed, setPromoteArmed] = useState(false);
  const [promoting, setPromoting] = useState(false);

  const canSave = title.trim() !== "" && body.trim() !== "";

  function handleSave() {
    if (!canSave) {
      return;
    }
    const existing = seed.id
      ? usePromptLibrary.getState().prompts.find((p) => p.id === seed.id)
      : undefined;
    const now = Date.now();
    const prompt: SavedPrompt = {
      body,
      createdMs: existing?.createdMs ?? now,
      favourite: existing?.favourite ?? false,
      id: seed.id ?? crypto.randomUUID(),
      lastUsedMs: existing?.lastUsedMs ?? null,
      tags: splitTags(tagsText),
      title,
      updatedMs: now,
      useCount: existing?.useCount ?? 0,
    };
    save(prompt);
    close();
  }

  function handleDelete() {
    if (!seed.id) {
      return;
    }
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    remove(seed.id);
    close();
  }

  async function doPromote(overwrite: boolean) {
    const projectId = scope === "project" ? (activeProject?.id ?? null) : null;
    setPromoting(true);
    try {
      const path = await promotePromptToCommand(
        projectId,
        slugify(title),
        title,
        body,
        overwrite
      );
      showToast(`Wrote ${path}`);
      setPromoteArmed(false);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!overwrite && message.includes("already exists")) {
        setPromoteArmed(true);
      } else {
        showToast(message, "error");
        setPromoteArmed(false);
      }
    } finally {
      setPromoting(false);
    }
  }

  function handlePromote() {
    if (promoting || !canSave) {
      return;
    }
    doPromote(promoteArmed).catch(() => {
      // doPromote reports failure via showToast; nothing else to do.
    });
  }

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <Overlay label="Close prompt editor" onClose={close}>
      <div data-testid="prompt-editor" style={panelStyle}>
        <input
          autoFocus
          onChange={(e) => {
            setTitle(e.target.value);
            // An armed overwrite confirms one specific target (scope+slug);
            // changing what the next click would write must disarm it.
            setPromoteArmed(false);
          }}
          placeholder="Title"
          style={titleFieldStyle}
          value={title}
        />
        <textarea
          onChange={(e) => {
            setBody(e.target.value);
            setPromoteArmed(false);
          }}
          rows={8}
          style={bodyFieldStyle}
          value={body}
        />
        <input
          onChange={(e) => setTagsText(e.target.value)}
          placeholder="tags, comma, separated"
          style={tagsFieldStyle}
          value={tagsText}
        />
        <div style={actionsStyle}>
          {seed.id ? (
            <button
              className="kr-hover-surface"
              onClick={handleDelete}
              style={dangerStyle}
              type="button"
            >
              {deleteArmed ? "Really delete?" : "Delete"}
            </button>
          ) : null}
          <select
            onChange={(e) => {
              setScope(e.target.value as "global" | "project");
              setPromoteArmed(false);
            }}
            style={selectStyle}
            value={scope}
          >
            <option value="global">Global</option>
            {activeProject ? (
              <option value="project">{activeProject.name}</option>
            ) : null}
          </select>
          <button
            className="kr-hover-surface"
            disabled={!canSave || promoting}
            onClick={handlePromote}
            style={secondaryStyle}
            type="button"
          >
            {promoteArmed
              ? `Overwrite /${slugify(title)}?`
              : "Promote to /command"}
          </button>
          <button
            className="kr-hover-surface"
            onClick={close}
            style={secondaryStyle}
            type="button"
          >
            Cancel
          </button>
          <button
            className="kr-hover-accent"
            disabled={!canSave}
            onClick={handleSave}
            style={primaryStyle}
            type="button"
          >
            Save prompt
          </button>
        </div>
      </div>
    </Overlay>
  );
}
