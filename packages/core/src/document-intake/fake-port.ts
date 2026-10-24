// The TypeScript stand-in for the Docling service (docs/requirements/document-intake.md DL-9): it
// returns fixed tables, can exceed a limit, time out or crash, and records what it was given, so
// `pnpm -r test` needs no Python, no model weights and no network.
import type { DoclingResult } from "@zs/contracts";
import { DoclingLimitError, type DoclingInput, type DoclingPort } from "./port.js";

export type FakeDoclingMode = "ok" | "too_many_pages" | "timeout" | "crash" | "hang";

/** Halden & Rowe's price list as the fake reads it: five columns, one table over two pages. */
export const FAKE_PRICE_LIST: DoclingResult = Object.freeze({
  pageCount: 2,
  parserVersion: "fake-docling-1",
  tables: [
    {
      headers: ["Item No", "Product", "Description", "Price", "Color"],
      rows: [
        { cells: ["HR-1001", "Linen shirt", "Relaxed fit", "$45.00", "Sand"], pageNo: 1, bbox: [0.09, 0.2, 0.9, 0.23], snippet: "HR-1001 | Linen shirt | Relaxed fit | $45.00 | Sand" },
        { cells: ["HR-2002", "Wool scarf", "Hand finished", "$38.50", "Grey"], pageNo: 1, bbox: [0.09, 0.23, 0.9, 0.26], snippet: "HR-2002 | Wool scarf | Hand finished | $38.50 | Grey" },
        { cells: ["", "Gift card", "Any amount", "$25.00", ""], pageNo: 2, bbox: [0.09, 0.2, 0.9, 0.23], snippet: " | Gift card | Any amount | $25.00 | " },
      ],
    },
  ],
}) as unknown as DoclingResult;

export interface FakeDoclingPort extends DoclingPort {
  /** Every input the port was given, in order. */
  readonly calls: DoclingInput[];
  /** Fixed result for one file (by SHA-256); other files get the default. */
  returnFor(fileSha256: string, result: DoclingResult): void;
  mode: FakeDoclingMode;
}

export function createFakeDoclingPort(options: { readonly result?: DoclingResult; readonly mode?: FakeDoclingMode } = {}): FakeDoclingPort {
  const byFile = new Map<string, DoclingResult>();
  const calls: DoclingInput[] = [];
  const port: FakeDoclingPort = {
    calls,
    mode: options.mode ?? "ok",
    returnFor: (fileSha256, result) => { byFile.set(fileSha256, result); },
    async extract(input) {
      calls.push(input);
      if (port.mode === "too_many_pages") throw new DoclingLimitError("too_many_pages");
      if (port.mode === "timeout") throw new DoclingLimitError("timeout");
      if (port.mode === "crash") throw new Error("the parser crashed");
      if (port.mode === "hang") await new Promise<never>(() => undefined);
      return byFile.get(input.fileSha256) ?? options.result ?? FAKE_PRICE_LIST;
    },
  };
  return port;
}
