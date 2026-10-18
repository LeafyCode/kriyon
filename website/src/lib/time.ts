export function pad(n: number) {
  return String(n).padStart(2, "0");
}

/** 252 → "04:12" */
export function formatSecs(secs: number) {
  return `${pad(Math.floor(secs / 60))}:${pad(secs % 60)}`;
}
