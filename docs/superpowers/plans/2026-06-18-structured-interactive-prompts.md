# Structured Interactive Prompts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface Claude's interactive prompts (the `AskUserQuestion` tool, permission/notification waits, and the resume compress-vs-continue prompt) in the Studio view, routing the user to the Raw terminal to answer.

**Architecture:** Detect structurally where Claude exposes a signal — `AskUserQuestion` from the transcript `tool_use` block, permission/notification waits from the existing `waiting` status. Never inject keystrokes and never scrape the terminal; every "answer" action just switches the view to Raw (`transcriptView: "raw"`) and focuses the xterm, which stays the source of truth. The resume prompt has no signal, so it gets a dismissible hint shown after every resume.

**Tech Stack:** Rust (`kriyon-core`, serde_json), React + TypeScript, Zustand store, Vitest + Testing Library, `@xterm/xterm`. Design tokens from `src/theme/tokens.ts`.

## Global Constraints

- Styling/colors/spacing come **only** from `src/theme/tokens.ts` — never hardcode (AGENTS.md).
- Formatting & JS/TS lint owned by Ultracite + Biome — run `pnpm fix`, never hand-format. `<button>` needs `type="button"` (Biome `useButtonType`).
- The transcript parser must **never hard-error** on unknown/malformed input — fall back, never panic (AGENTS.md, `StructuredEvent::Unknown` contract).
- A term must appear in `CONTEXT.md` before it becomes a module/type name (AGENTS.md). Task 1 does this first.
- Rust lint: clippy `pedantic`/`correctness` enforced.
- `pnpm check` must pass before every commit. Conventional commits, typed branch (already on `feat/session-activity`); never commit to `main`.
- TDD: write the failing test first, watch it fail, then implement.

---

### Task 1: Add terminology to CONTEXT.md

**Files:**
- Modify: `CONTEXT.md` (append three glossary entries in the existing `- **Term** — …` style)

**Interfaces:**
- Produces: the agreed terms **Question**, **Awaiting-input banner**, **Resume hint**, used as type/component names by later tasks.

- [ ] **Step 1: Add the three glossary entries**

Append after the existing `Pending prompt` / `Thinking indicator` entries (keep the file's bullet style):

```markdown
- **Question** (`StructuredEvent::Question`) — a [Structured event] reconstructed from an
  `AskUserQuestion` tool call: one or more multiple-choice questions Claude is asking the user.
  Rendered read-only in the [Studio view]; the user answers in the [Raw view].
- **Awaiting-input banner** — the actionable affordance shown in the [Studio view] while a
  Session's [Status] is `waiting`, routing the user to the [Raw view] to respond.
- **Resume hint** — the dismissible [Studio view] banner shown after resuming a [Past session],
  pointing the user to the [Raw view] in case Claude asks how to continue.
```

- [ ] **Step 2: Commit**

```bash
git add CONTEXT.md
git commit -m "docs(context): add terms for structured interactive prompts"
```

---

### Task 2: Rust core — `Question` structured event from `AskUserQuestion`

**Files:**
- Modify: `crates/kriyon-core/src/transcript.rs` (enum ~32-74, `kind_str` ~80-91, `map_tool_use` ~266-324, tests `#[cfg(test)]` module ~398+)

**Interfaces:**
- Produces (consumed by Task 3's TS mirror):
  - `StructuredEvent::Question { questions: Vec<QuestionItem> }`, serde `kind = "question"`.
  - `pub struct QuestionItem { header: String, question: String, multi_select: bool, options: Vec<QuestionOption> }` — serde `rename_all = "camelCase"` so `multi_select` → `multiSelect` on the wire.
  - `pub struct QuestionOption { label: String, description: String }`.

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` block (alongside `assistant_read_tool_use_targets_file_path`):

```rust
#[test]
fn assistant_ask_user_question_produces_question() {
    let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"AskUserQuestion","input":{"questions":[{"question":"Pick one?","header":"Choice","multiSelect":false,"options":[{"label":"A","description":"first"},{"label":"B","description":"second"}]}]}}]}}"#;
    assert_eq!(
        parse_line(line),
        vec![StructuredEvent::Question {
            questions: vec![QuestionItem {
                header: "Choice".to_string(),
                question: "Pick one?".to_string(),
                multi_select: false,
                options: vec![
                    QuestionOption {
                        label: "A".to_string(),
                        description: "first".to_string(),
                    },
                    QuestionOption {
                        label: "B".to_string(),
                        description: "second".to_string(),
                    },
                ],
            }],
        }]
    );
}

#[test]
fn malformed_ask_user_question_falls_back_to_tool() {
    let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"AskUserQuestion","input":{"foo":"bar"}}]}}"#;
    assert_eq!(
        parse_line(line),
        vec![StructuredEvent::Tool {
            name: "AskUserQuestion".to_string(),
            target: None,
            meta: None,
        }]
    );
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p kriyon-core ask_user_question`
Expected: FAIL — `QuestionItem`/`QuestionOption` undefined and `StructuredEvent::Question` missing.

- [ ] **Step 3: Add the types and variant**

In `transcript.rs`, add the variant to `StructuredEvent` (after `Code`, before `Usage`):

```rust
    /// One or more multiple-choice questions from an `AskUserQuestion` tool call.
    Question { questions: Vec<QuestionItem> },
```

Add the two structs just after the `StructuredEvent` enum / `DiffLine` neighbours:

```rust
/// One question within a [`StructuredEvent::Question`] (an `AskUserQuestion`
/// entry). `multi_select` distinguishes checkbox questions from radio ones.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionItem {
    pub header: String,
    pub question: String,
    pub multi_select: bool,
    pub options: Vec<QuestionOption>,
}

/// A selectable answer for a [`QuestionItem`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct QuestionOption {
    pub label: String,
    pub description: String,
}
```

Add the `kind_str` arm (in the `match self` block):

```rust
            Self::Question { .. } => "question",
```

- [ ] **Step 4: Parse `AskUserQuestion` in `map_tool_use`**

Extract the existing generic-tool body into a helper, then add the new branch. Replace the `_ => { … }` arm of `map_tool_use` with:

```rust
        "AskUserQuestion" => {
            map_ask_user_question(input).unwrap_or_else(|| generic_tool(name, input))
        }
        _ => generic_tool(name, input),
    }
}

/// The fallback tool mapping: name plus a best-effort `file_path`/`command`
/// target. Used for any tool without a richer structured form.
fn generic_tool(name: &str, input: Option<&Value>) -> StructuredEvent {
    let target = opt_input_str(input, "file_path").or_else(|| opt_input_str(input, "command"));
    StructuredEvent::Tool {
        name: name.to_string(),
        target,
        meta: None,
    }
}

/// Map an `AskUserQuestion` tool input into a [`StructuredEvent::Question`].
/// Returns `None` on any missing/malformed field so the caller can fall back to
/// the generic tool mapping — the parser never hard-errors.
fn map_ask_user_question(input: Option<&Value>) -> Option<StructuredEvent> {
    let questions = input?.get("questions")?.as_array()?;
    let mut items = Vec::new();
    for q in questions {
        let question = q.get("question")?.as_str()?.to_string();
        let header = q
            .get("header")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let multi_select = q
            .get("multiSelect")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let options = q
            .get("options")
            .and_then(Value::as_array)
            .map(|opts| {
                opts.iter()
                    .map(|o| QuestionOption {
                        label: opt_input_str(Some(o), "label").unwrap_or_default(),
                        description: opt_input_str(Some(o), "description").unwrap_or_default(),
                    })
                    .collect()
            })
            .unwrap_or_default();
        items.push(QuestionItem {
            header,
            question,
            multi_select,
            options,
        });
    }
    if items.is_empty() {
        return None;
    }
    Some(StructuredEvent::Question { questions: items })
}
```

Note: the original `_ =>` arm content (the `let target = …; StructuredEvent::Tool {…}`) now lives in `generic_tool`; delete the inline copy so it is not duplicated.

- [ ] **Step 5: Run tests + clippy**

Run: `cargo test -p kriyon-core && cargo clippy -p kriyon-core --all-targets`
Expected: PASS, no clippy warnings.

- [ ] **Step 6: Commit**

```bash
git add crates/kriyon-core/src/transcript.rs
git commit -m "feat(core): parse AskUserQuestion into a Question event"
```

---

### Task 3: Response primitive — `answerInTerminal` + terminal focus + the button

**Files:**
- Create: `src/studio/answerInTerminal.ts`
- Create: `src/studio/answerInTerminal.test.ts`
- Create: `src/studio/blocks/AnswerInTerminal.tsx`
- Modify: `src/terminal/Terminal.tsx` (the `useEffect([active])` at ~224-248)

**Interfaces:**
- Produces (consumed by Tasks 4, 5, 6):
  - `answerInTerminal(): void` — switches `layout.transcriptView` to `"raw"`.
  - `<AnswerInTerminal />` — a button labelled "Answer in terminal →" that calls `answerInTerminal()`. `data-testid="answer-in-terminal"`.

- [ ] **Step 1: Write the failing test for the helper**

Create `src/studio/answerInTerminal.test.ts`:

```ts
import { beforeEach, expect, test } from "vitest";
import { useSessions } from "../state/sessions.ts";
import { answerInTerminal } from "./answerInTerminal.ts";

beforeEach(() => {
  useSessions.setState({
    layout: { expandedProjectIds: [], transcriptView: "studio", view: "studio" },
  });
});

test("switches the transcript view to the raw terminal", () => {
  answerInTerminal();
  expect(useSessions.getState().layout.transcriptView).toBe("raw");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/studio/answerInTerminal.test.ts`
Expected: FAIL — module `./answerInTerminal.ts` not found.

- [ ] **Step 3: Implement the helper**

Create `src/studio/answerInTerminal.ts`:

```ts
import { useSessions } from "../state/sessions.ts";

/**
 * Route the user to the Raw terminal to answer an interactive prompt. The Studio
 * view never injects keystrokes or scrapes the terminal — the Raw view is the
 * source of truth, so "answering" means switching to it (the active Terminal
 * focuses itself on becoming active). Shared by the Question card, the
 * awaiting-input banner, and the resume hint.
 */
export function answerInTerminal(): void {
  useSessions.getState().setTranscriptView("raw");
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run src/studio/answerInTerminal.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for the button**

Create `src/studio/blocks/AnswerInTerminal.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { useSessions } from "../../state/sessions.ts";
import { AnswerInTerminal } from "./AnswerInTerminal.tsx";

beforeEach(() => {
  useSessions.setState({
    layout: { expandedProjectIds: [], transcriptView: "studio", view: "studio" },
  });
});

test("clicking switches to the raw terminal view", () => {
  render(<AnswerInTerminal />);
  fireEvent.click(screen.getByTestId("answer-in-terminal"));
  expect(useSessions.getState().layout.transcriptView).toBe("raw");
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm vitest run src/studio/blocks/AnswerInTerminal.test.tsx`
Expected: FAIL — component not found.

- [ ] **Step 7: Implement the button**

Create `src/studio/blocks/AnswerInTerminal.tsx`:

```tsx
import type { CSSProperties } from "react";
import { tokens } from "../../theme/tokens.ts";
import { answerInTerminal } from "../answerInTerminal.ts";

const buttonStyle: CSSProperties = {
  alignItems: "center",
  background: "transparent",
  border: `1px solid ${tokens.color.accent}`,
  borderRadius: tokens.radius.sm,
  color: tokens.color.accent,
  cursor: "pointer",
  display: "inline-flex",
  fontFamily: tokens.font.sans,
  fontSize: "12px",
  fontWeight: 600,
  gap: "6px",
  padding: "5px 11px",
};

/** "Answer in terminal →" — switches to the Raw view so the user responds there. */
export function AnswerInTerminal() {
  return (
    <button
      data-testid="answer-in-terminal"
      onClick={() => answerInTerminal()}
      style={buttonStyle}
      type="button"
    >
      Answer in terminal →
    </button>
  );
}
```

- [ ] **Step 8: Focus the terminal when it becomes active**

In `src/terminal/Terminal.tsx`, inside the `useEffect(() => { … }, [active])`, add a focus call at the top of the `if (active) {` branch (so switching to Raw focuses input):

```tsx
    if (active) {
      term.focus();
      if (!webglRef.current) {
```

- [ ] **Step 9: Run the button test + check**

Run: `pnpm vitest run src/studio/blocks/AnswerInTerminal.test.tsx && pnpm check`
Expected: PASS, check green.

- [ ] **Step 10: Commit**

```bash
git add src/studio/answerInTerminal.ts src/studio/answerInTerminal.test.ts src/studio/blocks/AnswerInTerminal.tsx src/studio/blocks/AnswerInTerminal.test.tsx src/terminal/Terminal.tsx
git commit -m "feat(studio): add answer-in-terminal response primitive"
```

---

### Task 4: TS types + the `Question` card + render dispatch

**Files:**
- Modify: `src/types.ts` (`StructuredEvent` union ~87-107, add `QuestionItem`/`QuestionOption`)
- Create: `src/studio/blocks/Question.tsx`
- Create: `src/studio/blocks/Question.test.tsx`
- Modify: `src/studio/StudioView.tsx` (`renderEvent` ~29-65, import)

**Interfaces:**
- Consumes: `StructuredEvent::Question` wire shape from Task 2 (`{ kind: "question", questions: [{ header, question, multiSelect, options: [{ label, description }] }] }`); `<AnswerInTerminal />` from Task 3.
- Produces: `<Question questions={…} />`, `data-testid="block-question"`.

- [ ] **Step 1: Add the TS mirror types**

In `src/types.ts`, add before `StructuredEvent` (near `DiffLine`):

```ts
/** A selectable answer for a {@link QuestionItem} (mirrors Rust `QuestionOption`). */
export interface QuestionOption {
  label: string;
  description: string;
}

/** One question in a {@link StructuredEvent} `question` event (mirrors Rust `QuestionItem`). */
export interface QuestionItem {
  header: string;
  question: string;
  multiSelect: boolean;
  options: QuestionOption[];
}
```

Add the union arm (after the `code` arm, before `usage`):

```ts
  | { kind: "question"; questions: QuestionItem[] }
```

- [ ] **Step 2: Write the failing test for the card**

Create `src/studio/blocks/Question.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { useSessions } from "../../state/sessions.ts";
import type { QuestionItem } from "../../types.ts";
import { Question } from "./Question.tsx";

const QUESTIONS: QuestionItem[] = [
  {
    header: "Choice",
    question: "Which approach?",
    multiSelect: false,
    options: [
      { label: "Option A", description: "the first one" },
      { label: "Option B", description: "the second one" },
    ],
  },
];

beforeEach(() => {
  useSessions.setState({
    layout: { expandedProjectIds: [], transcriptView: "studio", view: "studio" },
  });
});

test("renders the question text and every option", () => {
  render(<Question questions={QUESTIONS} />);
  expect(screen.getByTestId("block-question")).toHaveTextContent("Which approach?");
  expect(screen.getByText("Option A")).toBeInTheDocument();
  expect(screen.getByText("the second one")).toBeInTheDocument();
});

test("offers answering in the terminal", () => {
  render(<Question questions={QUESTIONS} />);
  fireEvent.click(screen.getByTestId("answer-in-terminal"));
  expect(useSessions.getState().layout.transcriptView).toBe("raw");
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm vitest run src/studio/blocks/Question.test.tsx`
Expected: FAIL — component not found.

- [ ] **Step 4: Implement the card**

Create `src/studio/blocks/Question.tsx`:

```tsx
import type { CSSProperties } from "react";
import { tokens } from "../../theme/tokens.ts";
import type { QuestionItem } from "../../types.ts";
import { AnswerInTerminal } from "./AnswerInTerminal.tsx";

const rootStyle: CSSProperties = {
  background: tokens.color.toolTint,
  border: `1px solid ${tokens.color.status.waiting}`,
  borderRadius: tokens.radius.md,
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  marginLeft: "23px",
  padding: "14px 16px",
};

const headerStyle: CSSProperties = {
  color: tokens.color.status.waiting,
  fontFamily: tokens.font.mono,
  fontSize: "10.5px",
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
};

const questionStyle: CSSProperties = {
  color: tokens.color.ink.primary,
  fontFamily: tokens.font.sans,
  fontSize: "13.5px",
  fontWeight: 600,
};

const optionStyle: CSSProperties = {
  borderLeft: `2px solid ${tokens.color.toolBorder}`,
  display: "flex",
  flexDirection: "column",
  gap: "2px",
  paddingLeft: "10px",
};

const optionLabelStyle: CSSProperties = {
  color: tokens.color.ink.primary,
  fontFamily: tokens.font.sans,
  fontSize: "12.5px",
  fontWeight: 600,
};

const optionDescStyle: CSSProperties = {
  color: tokens.color.ink.dim,
  fontFamily: tokens.font.sans,
  fontSize: "12px",
};

/**
 * A read-only reconstruction of an `AskUserQuestion` prompt. The Studio view
 * does not collect the answer — it shows what Claude is asking and routes the
 * user to the Raw terminal to respond (see {@link AnswerInTerminal}).
 */
export function Question({ questions }: { questions: QuestionItem[] }) {
  return (
    <div data-testid="block-question" style={rootStyle}>
      {questions.map((q) => (
        <div key={q.question} style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {q.header ? <span style={headerStyle}>{q.header}</span> : null}
          <span style={questionStyle}>{q.question}</span>
          {q.options.map((o) => (
            <div key={o.label} style={optionStyle}>
              <span style={optionLabelStyle}>{o.label}</span>
              {o.description ? <span style={optionDescStyle}>{o.description}</span> : null}
            </div>
          ))}
        </div>
      ))}
      <AnswerInTerminal />
    </div>
  );
}
```

- [ ] **Step 5: Add the render dispatch**

In `src/studio/StudioView.tsx`: add the import

```tsx
import { Question } from "./blocks/Question.tsx";
```

and the case in `renderEvent` (after `case "code":`):

```tsx
    case "question":
      return <Question key={key} questions={event.questions} />;
```

- [ ] **Step 6: Extend the StudioView ordering test**

In `src/studio/StudioView.test.tsx`, append a question event to the `EVENTS` array (after the `code` event):

```tsx
  {
    id: "e7:0",
    kind: "question",
    questions: [
      {
        header: "Choice",
        question: "Which approach?",
        multiSelect: false,
        options: [{ label: "A", description: "first" }],
      },
    ],
  },
```

and add `"block-question"` to the expected `order` array in the "renders one block per event" test (last entry).

- [ ] **Step 7: Run tests + check**

Run: `pnpm vitest run src/studio && pnpm check`
Expected: PASS, check green.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/studio/blocks/Question.tsx src/studio/blocks/Question.test.tsx src/studio/StudioView.tsx src/studio/StudioView.test.tsx
git commit -m "feat(studio): render AskUserQuestion as a Question card"
```

---

### Task 5: Awaiting-input banner (permission / notification waits)

**Files:**
- Modify: `src/studio/StudioView.tsx` (the `showThinking` / return block ~124-142)
- Modify: `src/studio/StudioView.test.tsx`

**Interfaces:**
- Consumes: `<AnswerInTerminal />` (Task 3); the existing `status === "waiting"` signal.
- Produces: when `status === "waiting"`, the Studio view renders `<AnswerInTerminal />` directly under the Thinking footer.

- [ ] **Step 1: Write the failing tests**

In `src/studio/StudioView.test.tsx`, add:

```tsx
test("shows answer-in-terminal while waiting on the user", () => {
  render(<StudioView sessionId="s1" />);
  act(() => {
    useSessions.setState({
      sessions: { s1: { ...SESSION, status: "waiting", summary: "Needs permission" } },
    });
  });
  expect(screen.getByTestId("answer-in-terminal")).toBeInTheDocument();
});

test("does not show answer-in-terminal while merely running", () => {
  render(<StudioView sessionId="s1" />);
  act(() => {
    useSessions.setState({
      sessions: { s1: { ...SESSION, status: "running", summary: "Running Bash…" } },
    });
  });
  expect(screen.queryByTestId("answer-in-terminal")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run src/studio/StudioView.test.tsx -t "answer-in-terminal"`
Expected: FAIL — no such element.

- [ ] **Step 3: Implement the banner**

In `src/studio/StudioView.tsx`, add the import:

```tsx
import { AnswerInTerminal } from "./blocks/AnswerInTerminal.tsx";
```

In the returned JSX, replace the thinking block with the footer plus the waiting affordance:

```tsx
      {showThinking ? (
        <Thinking status={thinkingStatus} summary={thinkingSummary} />
      ) : null}
      {status === "waiting" ? (
        <div style={{ marginLeft: "15px" }}>
          <AnswerInTerminal />
        </div>
      ) : null}
```

- [ ] **Step 4: Run tests + check**

Run: `pnpm vitest run src/studio/StudioView.test.tsx && pnpm check`
Expected: PASS, check green.

- [ ] **Step 5: Commit**

```bash
git add src/studio/StudioView.tsx src/studio/StudioView.test.tsx
git commit -m "feat(studio): surface awaiting-input banner while waiting on the user"
```

---

### Task 6: Resume hint

**Files:**
- Modify: `src/state/sessions.ts` (state shape ~43-79, initial state ~106-115, add reducers)
- Create: `src/studio/blocks/ResumeHint.tsx`
- Create: `src/studio/blocks/ResumeHint.test.tsx`
- Modify: `src/studio/StudioView.tsx` (read `resumeHint`, clear on running, render)
- Modify: `src/App.tsx` (arm the hint on a resumed launch ~88-91)
- Modify: `src/studio/StudioView.test.tsx` (reset `resumeHint` in `beforeEach`)

**Interfaces:**
- Consumes: `<AnswerInTerminal />` (Task 3); `launchClaudeOnce` return + `session.claudeSessionId` (App).
- Produces (store additions):
  - `resumeHint: Record<string, boolean>`
  - `armResumeHint: (id: string) => void`
  - `dismissResumeHint: (id: string) => void`
  - `<ResumeHint sessionId={…} />`, `data-testid="resume-hint"`, with a dismiss control `data-testid="resume-hint-dismiss"`.

- [ ] **Step 1: Write the failing store test**

Create `src/state/resumeHint.test.ts`:

```ts
import { beforeEach, expect, test } from "vitest";
import { useSessions } from "./sessions.ts";

beforeEach(() => {
  useSessions.setState({ resumeHint: {} });
});

test("arms and dismisses the resume hint per session", () => {
  useSessions.getState().armResumeHint("s1");
  expect(useSessions.getState().resumeHint.s1).toBe(true);
  useSessions.getState().dismissResumeHint("s1");
  expect(useSessions.getState().resumeHint.s1).toBe(false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/state/resumeHint.test.ts`
Expected: FAIL — `resumeHint`/`armResumeHint` undefined.

- [ ] **Step 3: Add the store slice**

In `src/state/sessions.ts`:

Add to the `SessionsState` interface (keep alphabetical-ish with neighbours):

```ts
  armResumeHint: (id: string) => void;
  dismissResumeHint: (id: string) => void;
  /** Sessions showing the post-resume "answer in the terminal" hint, until the first turn. */
  resumeHint: Record<string, boolean>;
```

Add to the initial state object (near `processing: {}`):

```ts
  resumeHint: {},
```

Add the reducers (near `setTranscriptView`):

```ts
  armResumeHint: (id) =>
    set((state) => ({ resumeHint: { ...state.resumeHint, [id]: true } })),

  dismissResumeHint: (id) =>
    set((state) => ({ resumeHint: { ...state.resumeHint, [id]: false } })),
```

- [ ] **Step 4: Run the store test to verify it passes**

Run: `pnpm vitest run src/state/resumeHint.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing component test**

Create `src/studio/blocks/ResumeHint.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { useSessions } from "../../state/sessions.ts";
import { ResumeHint } from "./ResumeHint.tsx";

beforeEach(() => {
  useSessions.setState({
    layout: { expandedProjectIds: [], transcriptView: "studio", view: "studio" },
    resumeHint: { s1: true },
  });
});

test("renders while armed and dismisses on click", () => {
  render(<ResumeHint sessionId="s1" />);
  expect(screen.getByTestId("resume-hint")).toBeInTheDocument();
  fireEvent.click(screen.getByTestId("resume-hint-dismiss"));
  expect(useSessions.getState().resumeHint.s1).toBe(false);
});

test("renders nothing when not armed", () => {
  useSessions.setState({ resumeHint: {} });
  render(<ResumeHint sessionId="s1" />);
  expect(screen.queryByTestId("resume-hint")).not.toBeInTheDocument();
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm vitest run src/studio/blocks/ResumeHint.test.tsx`
Expected: FAIL — component not found.

- [ ] **Step 7: Implement the hint**

Create `src/studio/blocks/ResumeHint.tsx`:

```tsx
import type { CSSProperties } from "react";
import { tokens } from "../../theme/tokens.ts";
import { useSessions } from "../../state/sessions.ts";
import { AnswerInTerminal } from "./AnswerInTerminal.tsx";

const rootStyle: CSSProperties = {
  alignItems: "center",
  background: tokens.color.toolTint,
  border: `1px solid ${tokens.color.toolBorder}`,
  borderRadius: tokens.radius.md,
  display: "flex",
  gap: "12px",
  marginLeft: "15px",
  padding: "10px 14px",
};

const textStyle: CSSProperties = {
  color: tokens.color.ink.dim,
  flex: 1,
  fontFamily: tokens.font.sans,
  fontSize: "12.5px",
};

const dismissStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  color: tokens.color.ink.faint,
  cursor: "pointer",
  fontFamily: tokens.font.sans,
  fontSize: "12px",
  padding: "2px 6px",
};

/**
 * Shown after resuming a session: the resume "compress vs continue" prompt has
 * no structured signal (it is TUI-only), so rather than detect it we point the
 * user to the Raw terminal in case Claude asks. Dismissible; auto-cleared by the
 * Studio view once the first turn starts.
 */
export function ResumeHint({ sessionId }: { sessionId: string }) {
  const armed = useSessions((state) => state.resumeHint[sessionId] ?? false);
  const dismiss = useSessions((state) => state.dismissResumeHint);
  if (!armed) {
    return null;
  }
  return (
    <div data-testid="resume-hint" style={rootStyle}>
      <span style={textStyle}>
        Resumed session — if Claude asks how to continue, answer in the terminal.
      </span>
      <AnswerInTerminal />
      <button
        data-testid="resume-hint-dismiss"
        onClick={() => dismiss(sessionId)}
        style={dismissStyle}
        type="button"
      >
        Dismiss
      </button>
    </div>
  );
}
```

- [ ] **Step 8: Render it + clear on first turn in StudioView**

In `src/studio/StudioView.tsx`:

Add imports:

```tsx
import { ResumeHint } from "./blocks/ResumeHint.tsx";
```

Add an effect (after the existing effects, before the `showThinking` consts) that clears the hint once a turn starts:

```tsx
  const dismissResumeHint = useSessions((state) => state.dismissResumeHint);
  useEffect(() => {
    if (status === "running") {
      dismissResumeHint(sessionId);
    }
  }, [status, sessionId, dismissResumeHint]);
```

Render the hint at the top of the scroll body (first child inside the root `div`):

```tsx
      <ResumeHint sessionId={sessionId} />
      {(events ?? []).map((event) => renderEvent(event, event.id))}
```

- [ ] **Step 9: Arm the hint on a resumed launch in App.tsx**

In `src/App.tsx`, pull `armResumeHint` from the store in the launch effect and arm it when a resumed session launches. Change the destructure (~79-83) and the `if (launched)` block (~88-91):

```tsx
    const {
      sessions: current,
      markBooting,
      markReady,
      armResumeHint,
    } = useSessions.getState();
```

```tsx
    const launched = launchClaudeOnce(activeSessionId, session.claudeSessionId);
    if (launched) {
      markBooting(activeSessionId);
      if (session.claudeSessionId) {
        armResumeHint(activeSessionId);
      }
    }
```

- [ ] **Step 10: Reset `resumeHint` in the StudioView test fixture**

In `src/studio/StudioView.test.tsx`, add `resumeHint: {},` to the `useSessions.setState({ … })` call in `beforeEach` so the new field is reset between tests.

- [ ] **Step 11: Run tests + check**

Run: `pnpm vitest run src/studio src/state && pnpm check`
Expected: PASS, check green.

- [ ] **Step 12: Commit**

```bash
git add src/state/sessions.ts src/state/resumeHint.test.ts src/studio/blocks/ResumeHint.tsx src/studio/blocks/ResumeHint.test.tsx src/studio/StudioView.tsx src/studio/StudioView.test.tsx src/App.tsx
git commit -m "feat(studio): show a resume hint pointing answers to the terminal"
```

---

## Self-Review

**Spec coverage:**
- AskUserQuestion → structured Question card: Tasks 2 (core), 4 (TS + card + render). ✓
- Permission/notification waits → awaiting-input banner from `waiting` status: Task 5. ✓
- Resume prompt → dismissible hint after every resume, no scraping: Task 6. ✓
- Response = switch to Raw + focus terminal, no injection: Task 3 (`answerInTerminal`, `term.focus()`). ✓
- Never hard-error in parser: Task 2 `map_ask_user_question` returns `None` → `generic_tool` fallback, with a test. ✓
- Tokens-only styling, `type="button"`, terms in CONTEXT.md first: Task 1 + every component uses `tokens`. ✓
- Non-goals (no keystroke injection, no scraping, no SDK migration, read-only options): respected — no task adds any of these. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code and exact commands. ✓

**Type consistency:** `QuestionItem`/`QuestionOption` defined in Task 2 (Rust) and Task 4 (TS) with matching field names; `multiSelect` (camelCase) consistent across wire, TS type, and test fixtures. `answerInTerminal`/`AnswerInTerminal` names consistent across Tasks 3–6. `resumeHint`/`armResumeHint`/`dismissResumeHint` consistent across Tasks 6 store, component, App. `data-testid` values (`block-question`, `answer-in-terminal`, `resume-hint`, `resume-hint-dismiss`) consistent between components and tests. ✓

**Refinement note (from spec):** if `AskUserQuestion` reports `running` (not `waiting`) via its PreToolUse hook, the awaiting-input banner won't appear during it — but the Question card (Task 4) always renders, so the prompt is still surfaced. The banner is for permission/notification waits, which already map to `waiting`. No change needed for v1.
