import { createFileRoute } from "@tanstack/react-router";
import { useRef } from "react";
import { Activity } from "../components/Activity.tsx";
import { Contribute } from "../components/Contribute.tsx";
import { FigOne } from "../components/FigOne.tsx";
import { Footer } from "../components/Footer.tsx";
import { Hero } from "../components/Hero.tsx";
import { Install } from "../components/Install.tsx";
import { Nav } from "../components/Nav.tsx";
import { Origin } from "../components/Origin.tsx";
import { RatingPlate } from "../components/RatingPlate.tsx";
import { Sessions } from "../components/Sessions.tsx";
import { Source } from "../components/Source.tsx";
import { Synopsis } from "../components/Synopsis.tsx";
import { Ticker } from "../components/Ticker.tsx";
import { Views } from "../components/Views.tsx";
import { useScrollReveals } from "../lib/useScrollReveals.ts";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  const rootRef = useRef<HTMLDivElement>(null);
  useScrollReveals(rootRef);

  return (
    <div className="page" ref={rootRef}>
      {/* Seven nav links precede the content on every load (WCAG 2.4.1). */}
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <span aria-hidden="true" className="edge-marks">
        <span className="tone-bg-blue" />
        <span className="tone-bg-amber" />
        <span className="tone-bg-green" />
      </span>
      <Nav />
      <main id="main">
        <Hero />
        <FigOne />
        <Ticker />
        <RatingPlate />
        <Synopsis />
        <Activity />
        <Views />
        <Sessions />
        <Source />
        <Contribute />
        <Install />
        <Origin />
      </main>
      <Footer />
    </div>
  );
}
