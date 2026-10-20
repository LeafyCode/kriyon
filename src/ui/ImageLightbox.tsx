import type { CSSProperties } from "react";
import { button } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import { useImagePreview } from "./imagePreview.ts";
import { Overlay } from "./Overlay.tsx";

const panelStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flexDirection: "column",
  gap: tokens.space.sm,
  maxWidth: "92vw",
  position: "relative",
};

const imageStyle: CSSProperties = {
  background: tokens.color.blockWell,
  borderRadius: tokens.radius.lg,
  boxShadow: tokens.shadow.pop,
  display: "block",
  maxHeight: "82vh",
  maxWidth: "92vw",
  objectFit: "contain",
};

const barStyle: CSSProperties = {
  alignItems: "center",
  color: tokens.color.ink.secondary,
  display: "flex",
  fontFamily: tokens.font.mono,
  fontSize: "11.5px",
  gap: tokens.space.md,
};

export interface ImageLightboxProps {
  name: string;
  onClose: () => void;
  /** Open the file in its default app (Preview). */
  onOpen?: () => void;
  path: string;
}

/** One image, full size, over a scrim: a click outside or Esc closes it. */
export function ImageLightbox({
  name,
  onClose,
  onOpen,
  path,
}: ImageLightboxProps) {
  const url = useImagePreview(path);
  return (
    <Overlay align="center" label="Close image" onClose={onClose}>
      <div style={panelStyle}>
        {url ? (
          // biome-ignore lint/correctness/useImageSize: shown at its own size, capped to the window; the size isn't known before it loads
          <img alt={name} src={url} style={imageStyle} />
        ) : (
          <p style={{ color: tokens.color.ink.muted }}>
            {url === null ? "This image can't be shown." : "Loading…"}
          </p>
        )}
        <div style={barStyle}>
          <span>{name}</span>
          {onOpen ? (
            <button
              className="kr-focusable kr-hover-surface"
              onClick={onOpen}
              style={button("secondary", "sm")}
              type="button"
            >
              Open in Preview
            </button>
          ) : null}
          <button
            className="kr-focusable kr-hover-surface"
            onClick={onClose}
            style={button("ghost", "sm")}
            type="button"
          >
            Close
          </button>
        </div>
      </div>
    </Overlay>
  );
}
