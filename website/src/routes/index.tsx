import { createFileRoute } from "@tanstack/react-router";
import { useRef } from "react";
import { Board } from "../components/Board.tsx";
import { Download } from "../components/Download.tsx";
import { Faq } from "../components/Faq.tsx";
import { Film } from "../components/Film.tsx";
import { Footer } from "../components/Footer.tsx";
import { Hero } from "../components/Hero.tsx";
import { Nav } from "../components/Nav.tsx";
import { OpenSource } from "../components/OpenSource.tsx";
import { Principle } from "../components/Principle.tsx";
import { Scenes } from "../components/Scenes.tsx";
import { useScrollReveals } from "../lib/useScrollReveals.ts";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  const rootRef = useRef<HTMLDivElement>(null);
  useScrollReveals(rootRef);

  return (
    <div ref={rootRef}>
      {/* Seven nav links precede the content on every load (WCAG 2.4.1). */}
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Nav />
      <main id="main">
        <Hero />
        <Principle />
        <Film />
        <Scenes />
        <Board />
        <OpenSource />
        <Faq />
        <Download />
      </main>
      <Footer />
    </div>
  );
}
