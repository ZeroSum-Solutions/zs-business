// Usage: node scripts/filter-outreach-list.mts in.json out.json [removed.json]
// Reads a JSON array of {email, domain, website, company, name} and drops every hard-suppressed
// prospect (Broken English, Rise Movement and their people). Run before any list reaches a sender.
import { readFileSync, writeFileSync } from "node:fs";
import { filterHardSuppressed } from "../packages/core/src/outreach/hard-suppression.ts";

const [input, output, removedOut] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: node scripts/filter-outreach-list.mts in.json out.json [removed.json]");
  process.exit(2);
}
const rows = JSON.parse(readFileSync(input, "utf8"));
if (!Array.isArray(rows)) throw new Error("input must be a JSON array");
const { kept, removed } = filterHardSuppressed(rows);
writeFileSync(output, JSON.stringify(kept, null, 2));
if (removedOut) writeFileSync(removedOut, JSON.stringify(removed, null, 2));
console.log(`kept ${kept.length}, removed ${removed.length}`);
