import { AlertTriangle, Folder, X } from "lucide-react";
import type { CSSProperties } from "react";
import { useState } from "react";
import { FileIcon } from "../changes/fileIcon.tsx";
import type { Attachment } from "../ipc/bridge.ts";
import { accentAlpha, tokens } from "../theme/tokens.ts";
import { ImageLightbox } from "../ui/ImageLightbox.tsx";
import { useImagePreview } from "../ui/imagePreview.ts";

const trayStyle: CSSProperties = {
  display: "flex",
  margin: 0,
  padding: 0,
  flexWrap: "wrap",
  gap: tokens.space.sm,
  marginBottom: tokens.space.sm,
};

const THUMB = 56;

function cardStyle(caution: boolean): CSSProperties {
  return {
    background: tokens.color.blockWell,
    border: `1px solid ${caution ? tokens.color.status.waiting : tokens.color.line.soft}`,
    borderRadius: tokens.radius.md,
    position: "relative",
  };
}

/** A file chip stands out from the composer's own fill with an accent tint,
 *  where a thumbnail's picture does that on its own. */
function fileCardStyle(caution: boolean): CSSProperties {
  return {
    ...cardStyle(caution),
    background: accentAlpha(0.16),
    border: `1px solid ${caution ? tokens.color.status.waiting : accentAlpha(0.45)}`,
  };
}

const removeStyle: CSSProperties = {
  alignItems: "center",
  background: tokens.color.chrome.content,
  border: `1px solid ${tokens.color.line.soft}`,
  borderRadius: tokens.radius.pill,
  color: tokens.color.ink.secondary,
  cursor: "pointer",
  display: "flex",
  height: "18px",
  justifyContent: "center",
  padding: 0,
  position: "absolute",
  right: "-6px",
  top: "-6px",
  width: "18px",
};

const fileStyle: CSSProperties = {
  alignItems: "center",
  color: tokens.color.ink.bright,
  display: "flex",
  fontFamily: tokens.font.mono,
  fontSize: "11.5px",
  gap: "6px",
  height: "32px",
  maxWidth: "220px",
  padding: "0 10px",
};

const nameStyle: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/** `long-file-na…e.png`: keep the end, where the extension is. */
export function shortName(name: string, max = 26): string {
  if (name.length <= max) {
    return name;
  }
  const tail = Math.min(10, Math.floor(max / 2));
  return `${name.slice(0, max - tail - 1)}…${name.slice(-tail)}`;
}

function Remove({ name, onRemove }: { name: string; onRemove: () => void }) {
  return (
    <button
      aria-label={`Remove ${name}`}
      className="kr-focusable kr-hover-surface"
      onClick={onRemove}
      style={removeStyle}
      title="Remove"
      type="button"
    >
      <X size={11} />
    </button>
  );
}

function ImageCard({
  attachment,
  onOpen,
  onRemove,
}: {
  attachment: Attachment;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const url = useImagePreview(attachment.path);
  return (
    <div style={cardStyle(attachment.caution !== null)}>
      <button
        aria-label={`View ${attachment.name}`}
        className="kr-focusable"
        onClick={onOpen}
        style={{
          background: "none",
          border: "none",
          cursor: "zoom-in",
          display: "block",
          height: THUMB,
          padding: 0,
          width: THUMB,
        }}
        title={attachment.caution ?? attachment.path}
        type="button"
      >
        {url ? (
          <img
            alt=""
            height={THUMB}
            src={url}
            style={{
              borderRadius: tokens.radius.md,
              display: "block",
              height: THUMB,
              objectFit: "cover",
              width: THUMB,
            }}
            width={THUMB}
          />
        ) : null}
      </button>
      {attachment.caution ? (
        <AlertTriangle
          aria-hidden
          size={13}
          style={{
            bottom: "3px",
            color: tokens.color.status.waiting,
            left: "3px",
            position: "absolute",
          }}
        />
      ) : null}
      <Remove name={attachment.name} onRemove={onRemove} />
    </div>
  );
}

function FileCard({
  attachment,
  onRemove,
}: {
  attachment: Attachment;
  onRemove: () => void;
}) {
  return (
    <div
      style={fileCardStyle(attachment.caution !== null)}
      title={attachment.caution ?? attachment.path}
    >
      <div style={fileStyle}>
        {attachment.kind === "folder" ? (
          <Folder
            size={13}
            style={{ color: tokens.color.ink.muted, flex: "none" }}
          />
        ) : (
          <FileIcon path={attachment.name} size={13} />
        )}
        <span style={nameStyle}>{shortName(attachment.name)}</span>
        {attachment.caution ? (
          <AlertTriangle
            aria-hidden
            size={12}
            style={{ color: tokens.color.status.waiting, flex: "none" }}
          />
        ) : null}
      </div>
      <Remove name={attachment.name} onRemove={onRemove} />
    </div>
  );
}

/** The composer's waiting [Attachment]s: image thumbnails (click to view)
 *  and file chips, each with its remove button and any caution. */
export function AttachmentTray({
  attachments,
  onRemove,
}: {
  attachments: Attachment[];
  onRemove: (path: string) => void;
}) {
  const [viewing, setViewing] = useState<Attachment | null>(null);
  if (attachments.length === 0) {
    return null;
  }
  return (
    <ul aria-label="Attachments" style={trayStyle}>
      {attachments.map((a) => (
        <li key={a.path} style={{ listStyle: "none" }}>
          {a.kind === "image" ? (
            <ImageCard
              attachment={a}
              onOpen={() => setViewing(a)}
              onRemove={() => onRemove(a.path)}
            />
          ) : (
            <FileCard attachment={a} onRemove={() => onRemove(a.path)} />
          )}
        </li>
      ))}
      {viewing ? (
        <ImageLightbox
          name={viewing.name}
          onClose={() => setViewing(null)}
          path={viewing.path}
        />
      ) : null}
    </ul>
  );
}
