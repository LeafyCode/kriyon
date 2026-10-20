import { type ShotName, shot } from "../lib/shots.ts";

interface ShotImageProps {
  alt: string;
  className?: string;
  /** High for the LCP hero, low for everything Chrome lazily reaches anyway. */
  fetchPriority?: "high" | "low";
  lazy?: boolean;
  name: ShotName;
  /** How wide this capture lands per breakpoint — see {@link shot}. */
  sizes: string;
}

/**
 * One app capture, served from its width ladder.
 *
 * The single place `width`/`height` are attached: they carry the intrinsic
 * ratio the CSS `aspect-ratio` boxes agree with, which is what holds CLS at
 * zero across all five screenshots.
 */
export function ShotImage({
  alt,
  className = "shot-img",
  fetchPriority,
  lazy = true,
  name,
  sizes,
}: ShotImageProps) {
  const { src, srcSet, width, height } = shot(name);
  return (
    <img
      alt={alt}
      className={className}
      fetchPriority={fetchPriority}
      height={height}
      loading={lazy ? "lazy" : "eager"}
      sizes={sizes}
      src={src}
      srcSet={srcSet}
      width={width}
    />
  );
}
