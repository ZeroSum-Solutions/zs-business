// A test-only estimate of a Shopify Admin GraphQL query's requested cost, by the defaults shopify.dev documents
// (GraphQL Admin API rate limits, "Cost calculation"): a scalar or enum is 0, an object 1, and a connection 2 plus
// `first` (or `last`) times the cost of one node. Its own example, products(first: 1) { edges { node { title } } },
// costs 3. Shopify refuses a query over 1,000 requested points before running it. This reads only the query shapes this
// repo sends (no fragments, no directives); it is independent of the production code that sizes the queries.
const TOKEN = /\s*(\.\.\.|[A-Za-z_$][\w$]*|[{}():,!]|"(?:[^"\\]|\\.)*"|-?\d+|\[|\]|=)/y;

function tokens(text: string): string[] {
  const out: string[] = [];
  TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while (TOKEN.lastIndex < text.length && (match = TOKEN.exec(text)) !== null) out.push(match[1]!);
  if (TOKEN.lastIndex < text.trimEnd().length) throw new Error(`query-cost: cannot read the query at ${TOKEN.lastIndex}`);
  return out;
}

export function requestedQueryCost(query: string, variables: Record<string, unknown> = {}): number {
  const t = tokens(query);
  let i = 0;
  // Skip `query Name($a: Int!, ...)` up to the operation's selection set.
  while (i < t.length && t[i] !== "{") i += 1;
  const size = (value: string): number => {
    const raw = value.startsWith("$") ? variables[value.slice(1)] : Number(value);
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) throw new Error(`query-cost: no page size for ${value}`);
    return raw;
  };
  /** Reads `{ ... }` at t[i] and returns the summed cost of its fields. */
  function selection(): number {
    if (t[i] !== "{") throw new Error("query-cost: expected {");
    i += 1;
    let total = 0;
    while (t[i] !== "}") {
      const name = t[i]!;
      i += 1;
      let page: number | null = null;
      if (t[i] === "(") {
        i += 1;
        while (t[i] !== ")") {
          const arg = t[i]!;
          i += 2; // name and ':'
          const value = t[i]!;
          i += 1;
          if (arg === "first" || arg === "last") page = size(value);
          if (t[i] === ",") i += 1;
        }
        i += 1;
      }
      if (t[i] !== "{") continue; // a scalar or enum: 0
      const inner = selection();
      if (page !== null) total += 2 + page * inner;
      else if (name === "nodes" || name === "edges" || name === "node") total += inner + (name === "edges" ? 0 : 1);
      else if (name === "pageInfo") total += 0;
      else total += 1 + inner;
    }
    i += 1;
    return total;
  }
  return selection();
}
