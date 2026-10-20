import {
  BREW_COMMAND,
  GITHUB_URL,
  ISSUES_URL,
  LEAFYCODE_NAME,
  RELEASES_URL,
} from "../lib/site.ts";

export function Install() {
  return (
    <section aria-labelledby="install-title" className="install" id="install">
      <div className="install-call">
        <span className="label">§ INSTALL</span>
        <h2 className="install-title" id="install-title">
          man kriyon
          <br />
          <span className="tone-blue-dark">→ install it.</span>
        </h2>
        <a
          className="btn-download btn-download-light"
          href={RELEASES_URL}
          rel="noreferrer"
          target="_blank"
        >
          <span aria-hidden="true" className="btn-download-icon">
            ↓
          </span>
          <span className="btn-download-label">DOWNLOAD THE SIGNED DMG</span>
        </a>
      </div>
      <dl className="install-facts">
        <dt>HOMEBREW</dt>
        <dd>{BREW_COMMAND}</dd>
        <dt>REQUIRES</dt>
        <dd>macOS 13+, claude CLI signed in</dd>
        <dt>LICENCE</dt>
        <dd>Apache-2.0</dd>
        <dt>REPO</dt>
        <dd>
          <a href={GITHUB_URL} rel="noreferrer" target="_blank">
            github.com/LeafyCode/kriyon
          </a>
        </dd>
        <dt>BUGS</dt>
        <dd>
          <a href={ISSUES_URL} rel="noreferrer" target="_blank">
            github.com/LeafyCode/kriyon/issues
          </a>
        </dd>
        <dt>PLATFORM</dt>
        <dd>macOS today · Windows, with your help</dd>
        <dt>AUTHORS</dt>
        <dd>{LEAFYCODE_NAME} and contributors</dd>
        <dt>MADE IN</dt>
        <dd className="tone-amber-dark">Sri Lanka</dd>
      </dl>
    </section>
  );
}
