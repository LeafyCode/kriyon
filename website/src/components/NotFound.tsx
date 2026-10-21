export function NotFound() {
  return (
    <main className="not-found">
      <div>
        <p className="label">KRIYON(1) · ERRORS</p>
        <h1 className="not-found-title">
          No manual entry<span className="tone-blue">.</span>
        </h1>
        <p className="not-found-code">$ man kriyon-404 · exit 16</p>
        <a className="mono-link" href="/">
          ← BACK TO KRIYON(1)
        </a>
      </div>
    </main>
  );
}
