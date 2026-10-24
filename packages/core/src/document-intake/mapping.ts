// Document intake (docs/requirements/document-intake.md DL-11): server code maps the header cells of
// an extracted table to catalog fields with a fixed synonym list, parses prices deterministically into
// minor units, and compares each row by SKU with the tenant's live items. Pure functions: no clock,
// no database, no model. Extracted text is data; nothing here sends it anywhere.
import { createHash } from "node:crypto";
import {
  CATALOG_FIELD_NAMES,
  CATALOG_MAX_ATTRIBUTES,
  CATALOG_MAX_PRICE_MINOR,
  isActiveCurrencyCode,
  type Bbox,
  type CatalogFieldName,
  type CatalogFields,
  type DoclingResult,
  type DoclingRow,
  type IntakeDiffOp,
  type IntakeInvalidReason,
} from "@zs/contracts";

const SKU_MAX = 64;
const TITLE_MAX = 300;
const ATTRIBUTE_KEY_MAX = 60;
const ATTRIBUTE_VALUE_MAX = 500;

/** The field each header spelling means. Headers compare lower-case with only letters and digits kept. */
const SYNONYMS: Readonly<Record<"sku" | "title" | "description" | "price" | "currency", readonly string[]>> = Object.freeze({
  sku: ["sku", "itemno", "itemnumber", "itemcode", "partno", "partnumber", "productcode", "productno", "article", "articleno", "code", "style", "stylenumber", "stylecode", "model", "modelno"],
  title: ["title", "name", "productname", "itemname", "product", "item"],
  description: ["description", "desc", "details", "productdescription", "itemdescription"],
  price: ["price", "unitprice", "retail", "retailprice", "msrp", "rrp", "listprice", "sellingprice", "saleprice"],
  currency: ["currency", "curr", "ccy", "currencycode"],
});
type MappedField = keyof typeof SYNONYMS;

export const normalizeHeader = (header: string): string => header.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Minor-unit exponents other than two (ISO 4217). */
const ZERO_DECIMAL: ReadonlySet<string> = new Set(["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF"]);
const THREE_DECIMAL: ReadonlySet<string> = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);
export const minorUnitExponent = (currency: string): number => (ZERO_DECIMAL.has(currency) ? 0 : THREE_DECIMAL.has(currency) ? 3 : 2);

/**
 * "12.50", "$1,234.5", "1.234,50", "1 234,50" and "1,234" to minor units, or null when the cell is
 * not a price. A lone "." is a decimal point; a lone "," is a thousands mark only when exactly three
 * digits follow it. More decimals than the currency has must be zeros. Integer arithmetic only.
 */
export function parsePrice(cell: string, currency: string): number | null {
  const compact = cell.replace(/[\s  ]/g, "").replace(/^[$€£¥₹]/u, "").replace(/[$€£¥₹]$/u, "");
  if (!/^(\d[\d.,]*|[.,]\d+)$/.test(compact)) return null;
  const lastDot = compact.lastIndexOf(".");
  const lastComma = compact.lastIndexOf(",");
  let whole: string;
  let fraction = "";
  const groupsOfThree = (text: string, mark: string): boolean => {
    const parts = text.split(mark);
    return parts.slice(1).every((part) => part.length === 3) && parts[0]!.length >= 1 && parts[0]!.length <= 3;
  };
  if (lastDot >= 0 && lastComma >= 0) {
    const decimalMark = lastDot > lastComma ? "." : ",";
    const thousandsMark = decimalMark === "." ? "," : ".";
    const at = compact.lastIndexOf(decimalMark);
    const head = compact.slice(0, at);
    if (head.includes(decimalMark) || !groupsOfThree(head, thousandsMark)) return null;
    whole = head.split(thousandsMark).join("");
    fraction = compact.slice(at + 1);
  } else if (lastDot >= 0 || lastComma >= 0) {
    const mark = lastDot >= 0 ? "." : ",";
    const count = compact.split(mark).length - 1;
    const at = compact.lastIndexOf(mark);
    const after = compact.slice(at + 1);
    if (count > 1) {
      if (!groupsOfThree(compact, mark)) return null;
      whole = compact.split(mark).join("");
    } else if (mark === "," && after.length === 3 && at >= 1 && at <= 3) {
      whole = compact.slice(0, at) + after;
    } else {
      whole = compact.slice(0, at);
      fraction = after;
    }
  } else {
    whole = compact;
  }
  if (whole === "") whole = "0";
  if (!/^\d+$/.test(whole) || (fraction !== "" && !/^\d+$/.test(fraction))) return null;
  const exponent = minorUnitExponent(currency);
  const kept = fraction.slice(0, exponent);
  if (/[^0]/.test(fraction.slice(exponent))) return null;
  const minor = BigInt(whole) * 10n ** BigInt(exponent) + BigInt(kept.padEnd(exponent, "0") || "0");
  if (minor > BigInt(CATALOG_MAX_PRICE_MINOR)) return null;
  return Number(minor);
}

/** One extracted row, mapped. `fields` is set only when the row is valid. */
export interface MappedRow {
  readonly rowIndex: number;
  readonly pageNo: number;
  readonly bbox: Bbox;
  readonly snippet: string;
  readonly cells: readonly string[];
  readonly fields: CatalogFields | null;
  readonly invalid: IntakeInvalidReason | null;
}

interface ColumnMap {
  readonly fields: Partial<Record<MappedField, number>>;
  readonly attributes: readonly { readonly index: number; readonly key: string }[];
  readonly headers: readonly string[];
}

function mapColumns(headers: readonly string[]): ColumnMap {
  const normalized = headers.map(normalizeHeader);
  const fields: Partial<Record<MappedField, number>> = {};
  const used = new Set<number>();
  for (const field of Object.keys(SYNONYMS) as MappedField[]) {
    const at = normalized.findIndex((header, index) => !used.has(index) && SYNONYMS[field].includes(header));
    if (at >= 0) { fields[field] = at; used.add(at); }
  }
  const attributes = headers.flatMap((header, index) =>
    used.has(index) ? [] : [{ index, key: header.trim().slice(0, ATTRIBUTE_KEY_MAX) || `column_${index + 1}` }]);
  return { fields, attributes, headers: normalized };
}

const blank = (cells: readonly string[]): boolean => cells.every((cell) => cell.trim() === "");
const repeatsHeader = (cells: readonly string[], headers: readonly string[]): boolean =>
  cells.some((cell) => cell.trim() !== "") && cells.every((cell, i) => normalizeHeader(cell) === (headers[i] ?? ""));

/** Map every table of a result to rows in document order, skipping empty rows and repeated header rows. */
export function mapResult(result: DoclingResult, defaultCurrency: string): MappedRow[] {
  interface Raw { readonly row: DoclingRow; readonly columns: ColumnMap }
  const raw: Raw[] = [];
  for (const table of result.tables) {
    const columns = mapColumns(table.headers);
    for (const row of table.rows) {
      if (!blank(row.cells) && !repeatsHeader(row.cells, columns.headers)) raw.push({ row, columns });
    }
  }
  const keyOf = ({ row, columns }: Raw): string => {
    const at = columns.fields.sku;
    return at === undefined ? "" : (row.cells[at] ?? "").trim();
  };
  // A SKU repeated in the job makes every occurrence invalid: the owner cannot tell which one wins.
  const counts = new Map<string, number>();
  for (const item of raw) {
    const key = keyOf(item);
    if (key !== "") counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return raw.map((item, index): MappedRow => {
    const { row, columns } = item;
    const cell = (field: MappedField): string => {
      const at = columns.fields[field];
      return at === undefined ? "" : (row.cells[at] ?? "").trim();
    };
    const sku = keyOf(item);
    const title = cell("title");
    const currencyCell = cell("currency").toUpperCase();
    const currency = currencyCell === "" ? defaultCurrency : currencyCell;
    const attributes: Record<string, string> = {};
    let tooLong = sku.length > SKU_MAX || title.length > TITLE_MAX;
    for (const attribute of columns.attributes) {
      const value = (row.cells[attribute.index] ?? "").trim();
      if (value === "") continue;
      if (value.length > ATTRIBUTE_VALUE_MAX || Object.keys(attributes).length >= CATALOG_MAX_ATTRIBUTES) tooLong = true;
      else attributes[attribute.key] ??= value;
    }
    const priceMinor = parsePrice(cell("price"), isActiveCurrencyCode(currency) ? currency : defaultCurrency);
    let invalid: IntakeInvalidReason | null = null;
    if (sku === "") invalid = "missing_key";
    else if ((counts.get(sku) ?? 0) > 1) invalid = "duplicate_key";
    else if (title === "") invalid = "missing_title";
    else if (priceMinor === null) invalid = "bad_price";
    else if (!isActiveCurrencyCode(currency)) invalid = "bad_currency";
    else if (tooLong) invalid = "field_too_long";
    return {
      rowIndex: index + 1, pageNo: row.pageNo, bbox: row.bbox, snippet: row.snippet, cells: row.cells, invalid,
      fields: invalid === null
        ? { sku, title, description: cell("description"), priceMinor: priceMinor!, currency, attributes, active: true }
        : null,
    };
  });
}

/** A live item as the diff compares it. */
export interface LiveItem {
  readonly id: string;
  readonly revision: number;
  readonly fields: CatalogFields;
}

export interface DiffRow {
  readonly rowIndex: number;
  readonly diffOp: IntakeDiffOp;
  readonly invalidReason: IntakeInvalidReason | null;
  readonly existingTargetId: string | null;
  readonly existingRevision: number | null;
  readonly proposed: CatalogFields | null;
  readonly current: CatalogFields | null;
  readonly changedFields: readonly CatalogFieldName[];
  readonly cells: readonly string[];
  readonly pageNo: number;
  readonly bbox: Bbox;
  readonly snippet: string;
  /** DL-13: the server's default; true for insert and update. */
  readonly included: boolean;
}

/** Canonical JSON: keys sorted, so equal values give equal text. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

const sameFields = (a: CatalogFields, b: CatalogFields, name: CatalogFieldName): boolean =>
  canonicalJson(a[name]) === canonicalJson(b[name]);

/** Compare mapped rows with the live items by exact SKU. An inactive item that a row lists is an update that reactivates it. */
export function buildDiff(rows: readonly MappedRow[], live: ReadonlyMap<string, LiveItem>): DiffRow[] {
  return rows.map((row): DiffRow => {
    const common = { rowIndex: row.rowIndex, cells: row.cells, pageNo: row.pageNo, bbox: row.bbox, snippet: row.snippet };
    if (row.invalid !== null || row.fields === null) {
      return {
        ...common, diffOp: "invalid", invalidReason: row.invalid ?? "missing_key", existingTargetId: null, existingRevision: null,
        proposed: null, current: null, changedFields: [], included: false,
      };
    }
    const existing = live.get(row.fields.sku);
    if (!existing) {
      return {
        ...common, diffOp: "insert", invalidReason: null, existingTargetId: null, existingRevision: null,
        proposed: row.fields, current: null, changedFields: [], included: true,
      };
    }
    const changedFields = CATALOG_FIELD_NAMES.filter((name) => !sameFields(row.fields!, existing.fields, name));
    return {
      ...common, diffOp: changedFields.length === 0 ? "unchanged" : "update", invalidReason: null,
      existingTargetId: existing.id, existingRevision: existing.revision,
      proposed: row.fields, current: existing.fields, changedFields, included: changedFields.length > 0,
    };
  });
}

/** DL-11: SHA-256 over the canonical rows. Provenance is part of it: a different page or box is a different diff. */
export function diffDigest(rows: readonly DiffRow[]): string {
  const canonical = rows.map((row) => ({
    i: row.rowIndex, op: row.diffOp, reason: row.invalidReason, id: row.existingTargetId, rev: row.existingRevision,
    proposed: row.proposed, changed: row.changedFields, page: row.pageNo, bbox: row.bbox,
  }));
  return createHash("sha256").update(canonicalJson(canonical)).digest("hex");
}

/** The digest of a validated worker result, so a retried result for the same attempt can be told apart from a different one. */
export function resultDigest(result: DoclingResult): string {
  return createHash("sha256").update(canonicalJson(result)).digest("hex");
}

export function countOps(rows: readonly DiffRow[]): Record<IntakeDiffOp, number> {
  const counts: Record<IntakeDiffOp, number> = { insert: 0, update: 0, unchanged: 0, invalid: 0 };
  for (const row of rows) counts[row.diffOp] += 1;
  return counts;
}
