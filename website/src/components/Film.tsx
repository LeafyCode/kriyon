import { FILM_SECONDS, FilmStage } from "../film/FilmStage.tsx";

export function Film() {
  return (
    <section className="film" id="film">
      <div className="film-heading" data-reveal={0}>
        <h2>
          The <span className="gradient-text">film</span>.
        </h2>
        <span className="film-meta">{FILM_SECONDS} SECONDS · LOOPS</span>
      </div>
      <p className="film-sub" data-reveal={1}>
        A day of parallel work, compressed to a minute — three sessions run, one
        raises its hand, a worktree merges clean.
      </p>
      <div className="film-stage-wrap" data-reveal={2}>
        <div className="film-glow" />
        <FilmStage />
      </div>
    </section>
  );
}
