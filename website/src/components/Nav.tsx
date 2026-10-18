import { GITHUB_URL } from "../lib/site.ts";

export function Nav() {
  return (
    <nav className="nav">
      <div className="nav-inner">
        <a className="nav-brand" href="#top">
          {/* The adjacent KRIYON wordmark already names this link. */}
          <img alt="" height={25} src="/logo-purple.svg" width={22} />
          <span>KRIYON</span>
        </a>
        <div className="nav-links">
          <a href="#film">FILM</a>
          <a href="#scenes">SCENES</a>
          <a href="#board">THE BOARD</a>
          <a href="#open">OPEN SOURCE</a>
          <a href="#faq">FAQ</a>
          <a href={GITHUB_URL} rel="noreferrer" target="_blank">
            GITHUB ↗
          </a>
          <a className="nav-download" href="#download">
            DOWNLOAD
          </a>
        </div>
      </div>
    </nav>
  );
}
