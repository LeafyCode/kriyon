export function Principle() {
  return (
    <section className="principle">
      <h2 className="eyebrow" data-reveal={0}>
        HOW IT WORKS
      </h2>
      <div className="principle-grid" data-reveal={1}>
        <div className="principle-cell">
          <p className="principle-number">01</p>
          <h3>The terminal is the truth</h3>
          <p>
            Every session runs your own{" "}
            <span className="inline-code">claude</span> in a genuine terminal.
            vim, ssh, REPLs, colors — all real, nothing simulated.
          </p>
        </div>
        <div className="principle-cell">
          <p className="principle-number">02</p>
          <h3>Kriyon shows the work</h3>
          <p>
            Beside the terminal sits a live diff of every file the session
            touched — its own work, not the whole repo. Read it, edit it, save
            it, without leaving the window.
          </p>
        </div>
        <div className="principle-cell">
          <p className="principle-number">03</p>
          <h3>Nothing to sign into</h3>
          <p>
            No accounts, no stored keys. Kriyon drives the CLI you already
            authenticated — and sessions survive even if the app crashes or
            updates.
          </p>
        </div>
      </div>
      <p className="principle-quote" data-reveal={2}>
        "The terminal is the truth. <span>Kriyon is the control room.</span>"
      </p>
    </section>
  );
}
