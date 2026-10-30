import { LEAFYCODE_NAME, LEAFYCODE_URL } from "../lib/site.ts";

/** The Leafy Code International leaf, sized by the caller's CSS. */
export function LeafyMark({ className }: Readonly<{ className?: string }>) {
  return (
    <img
      alt=""
      className={className ?? "leafy-mark"}
      height={20}
      src="/leafycode-logo.svg"
      width={20}
    />
  );
}

/** The maker's credit: the leaf, the full company name, and a link out. */
export function LeafyCredit() {
  return (
    <a
      className="leafy-credit"
      href={LEAFYCODE_URL}
      rel="noreferrer"
      target="_blank"
    >
      <LeafyMark />
      <span>
        A <b>{LEAFYCODE_NAME.toUpperCase()}</b> PROJECT ↗
      </span>
    </a>
  );
}
