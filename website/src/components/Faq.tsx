import type { ReactNode } from "react";

const QUESTIONS: Array<{ q: string; a: ReactNode }> = [
  {
    q: "Do I need anything besides the Claude CLI?",
    a: (
      <>
        No. If <span className="inline-code">claude</span> works in your
        terminal, Kriyon works. It uses your existing authentication and plan —
        no extra account, key, or subscription.
      </>
    ),
  },
  {
    q: "Does Kriyon send my code anywhere?",
    a: "No. The CLI talks to Anthropic exactly as it would in any terminal. Kriyon adds a window around it — file access is sandboxed to your project roots, and there’s no server of ours in between.",
  },
  {
    q: "Can Kriyon answer Claude's questions for me?",
    a: "Deliberately not. Kriyon tells you which session is waiting and what it asked, but you always answer in the real terminal. The agent never hears anyone but you.",
  },
  {
    q: "What happens if Kriyon crashes mid-session?",
    a: "Your sessions keep going. Each terminal runs in its own long-lived background process, so Claude and your shells survive crashes and app updates. Reopening reconnects and repaints instantly.",
  },
  {
    q: "Is there a Windows or Linux version?",
    a: "Kriyon is macOS-first today. Windows and Linux versions are coming — watch the GitHub repo for progress.",
  },
  {
    q: "Is Kriyon affiliated with Anthropic?",
    a: "No — it's an independent open-source project that works with the official CLI. It is not affiliated with, endorsed by, or sponsored by Anthropic. Claude and Claude Code are trademarks of Anthropic, PBC.",
  },
];

export function Faq() {
  return (
    <section className="faq" id="faq">
      <h2 data-reveal={0}>
        Questions<span>.</span>
      </h2>
      <div className="faq-list" data-reveal={1}>
        {QUESTIONS.map(({ q, a }) => (
          <details key={q}>
            <summary>
              {q}
              <span aria-hidden className="faq-plus">
                +
              </span>
            </summary>
            <p>{a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
