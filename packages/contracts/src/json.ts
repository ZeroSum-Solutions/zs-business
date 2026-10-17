import { z } from "zod";

export const isPostgresText = (value: string): boolean =>
  !/[\u0000\uD800-\uDFFF]/u.test(value);

// Bound work before the recursive zod parser or JSON canonicalization runs.
function safeJson(value: unknown): boolean {
  const stack = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let textBudget = 262144;
  while (stack.length) {
    const item = stack.pop()!;
    if (++nodes > 10000 || item.depth > 32) return false;
    const current = item.value;
    if (typeof current === "string") {
      if (!isPostgresText(current)) return false;
      textBudget -= current.length;
    } else if (typeof current === "number") {
      if (!Number.isFinite(current)) return false;
    } else if (current !== null && typeof current === "object") {
      if (seen.has(current)) return false;
      seen.add(current);
      if (
        !Array.isArray(current) &&
        ![Object.prototype, null].includes(Object.getPrototypeOf(current))
      )
        return false;
      if (
        Array.isArray(current) &&
        current.length + nodes + stack.length > 10000
      )
        return false;
      const entries = Object.entries(current);
      if (entries.length + nodes + stack.length > 10000) return false;
      for (const [key, child] of entries) {
        if (!isPostgresText(key)) return false;
        textBudget -= key.length;
        stack.push({ value: child, depth: item.depth + 1 });
      }
    } else if (current !== null && typeof current !== "boolean") return false;
    if (textBudget < 0) return false;
  }
  return true;
}

export const jsonValueSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    if (!safeJson(value))
      ctx.addIssue({
        code: "custom",
        message:
          "JSON must use valid Postgres text, at most 32 levels, 10000 nodes and 262144 text units; cycles and shared object references are rejected",
      });
  })
  .pipe(z.json());
export type JsonValue = z.infer<typeof jsonValueSchema>;
