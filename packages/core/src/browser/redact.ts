// BT-8: the sign-in values stay inside the sign-in. A supplier page may echo them back (a greeting,
// a form value, a link or a redirect to /users/<name>), so everything the runner derives from a page
// passes through this before it reaches the planner, the step history, an event URL or a file name.
// Each value is replaced by its placeholder, in any letter case, raw or URL-encoded.

export interface SecretValues {
  readonly username: string;
  readonly password: string;
}
export interface SecretRedactor {
  /** The text with every sign-in value replaced by `{{username}}` or `{{password}}`. */
  text(value: string): string;
  /** `text`, and a URL that changed is re-serialized, so a resolved link and a recorded step compare equal. */
  url(value: string): string;
  /** `text` applied to every string inside a JSON-like value. */
  deep<T>(value: T): T;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The forms a value takes in page text and URLs: as is, `encodeURIComponent`, form-encoded and `encodeURI`. */
function variants(value: string): string[] {
  const forms = new Set([value, encodeURIComponent(value), new URLSearchParams({ v: value }).toString().slice(2), encodeURI(value)]);
  return [...forms].filter((form) => form.length > 0);
}

export function createSecretRedactor(secrets: SecretValues | null | undefined): SecretRedactor {
  const entries: { form: string; placeholder: string }[] = [];
  if (secrets) {
    for (const [value, placeholder] of [[secrets.password, "{{password}}"], [secrets.username, "{{username}}"]] as const)
      if (value) for (const form of variants(value)) entries.push({ form, placeholder });
  }
  // Longest first, so a value that contains the other is replaced whole.
  entries.sort((a, b) => b.form.length - a.form.length);
  const placeholderOf = new Map<string, string>();
  for (const entry of entries) if (!placeholderOf.has(entry.form.toLowerCase())) placeholderOf.set(entry.form.toLowerCase(), entry.placeholder);
  const pattern = entries.length > 0 ? new RegExp(entries.map((entry) => escape(entry.form)).join("|"), "gi") : null;

  const text = (value: string) => (pattern ? value.replace(pattern, (match) => placeholderOf.get(match.toLowerCase()) ?? "{{password}}") : value);
  const url = (value: string) => {
    const redacted = text(value);
    if (redacted === value) return value;
    try { return new URL(redacted).href; } catch { return redacted; }
  };
  const deep = <T>(value: T): T => {
    if (typeof value === "string") return text(value) as T;
    if (Array.isArray(value)) return value.map((item) => deep(item)) as T;
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [text(key), deep(item)])) as T;
    return value;
  };
  return { text, url, deep };
}
