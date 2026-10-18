/**
 * [Placeholder] parsing and resolution for [Saved prompt]s: `{name}` slots
 * filled via inline fields in the [Prompt picker] at insert time, plus the
 * reserved `{clipboard}` that resolves silently from the pasteboard.
 * Pure functions — no UI, no IPC.
 */

export const CLIPBOARD_PLACEHOLDER = "clipboard";

/** `{name}`: one line, letters/digits/dash/underscore/space, non-empty. */
const PLACEHOLDER_RE = /\{([\w- ]+)\}/g;

/** Unique `{name}` placeholders in body order, excluding `{clipboard}`. */
export function parsePlaceholders(body: string): string[] {
  const names: string[] = [];
  for (const match of body.matchAll(PLACEHOLDER_RE)) {
    const [, name] = match;
    if (name !== CLIPBOARD_PLACEHOLDER && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

/**
 * Fill `{name}` slots from `values` and `{clipboard}` from `clipboardText`.
 * A name with no provided value resolves to the empty string.
 */
export function resolvePlaceholders(
  body: string,
  values: Record<string, string>,
  clipboardText: string
): string {
  // `replace` with a /g regex substitutes every match (ES2020-safe, no `replaceAll`).
  return body.replace(PLACEHOLDER_RE, (_whole: string, name: string) => {
    if (name === CLIPBOARD_PLACEHOLDER) {
      return clipboardText;
    }
    const value = values[name];
    return typeof value === "string" ? value : "";
  });
}
