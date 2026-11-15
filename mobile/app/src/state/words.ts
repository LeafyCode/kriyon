/**
 * The words to show for something that went wrong. A native call's
 * refusal reaches JS wrapped by Expo ("Call to function 'KriyonNative.x'
 * has been rejected.\n→ Caused by: <reason>"): the person reads the reason,
 * the innermost one when it is wrapped more than once.
 */
const CAUSED_BY = "→ Caused by: ";

export function wordsOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const at = message.lastIndexOf(CAUSED_BY);
  return at < 0 ? message : message.slice(at + CAUSED_BY.length).trim();
}
