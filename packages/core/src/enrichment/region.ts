// enrichment.md E-7: no enrichment of EU, EEA or UK contacts before a GDPR review. The list below is
// the single source: country codes, E.164 calling prefixes and ccTLDs are derived from it.
export interface RefusedCountry {
  readonly code: string;
  readonly name: string;
  /** Other spellings a free-text location may use, lowercase. */
  readonly aliases: readonly string[];
  readonly prefixes: readonly string[];
  readonly tlds: readonly string[];
}
const c = (code: string, name: string, prefixes: string[], tlds: string[], aliases: string[] = []): RefusedCountry =>
  Object.freeze({ code, name, aliases: Object.freeze(aliases), prefixes: Object.freeze(prefixes), tlds: Object.freeze(tlds) });

/** The EU 27, Iceland, Liechtenstein and Norway, the UK with its Crown Dependencies and Gibraltar,
 *  and the EU outermost regions that have their own calling codes or country codes. */
export const ENRICHMENT_REFUSED_REGION: readonly RefusedCountry[] = Object.freeze([
  c("AT", "Austria", ["+43"], ["at"], ["osterreich", "österreich"]),
  c("BE", "Belgium", ["+32"], ["be"], ["belgique", "belgie", "belgië"]),
  c("BG", "Bulgaria", ["+359"], ["bg"]),
  c("HR", "Croatia", ["+385"], ["hr"], ["hrvatska"]),
  c("CY", "Cyprus", ["+357"], ["cy"]),
  c("CZ", "Czechia", ["+420"], ["cz"], ["czech republic"]),
  c("DK", "Denmark", ["+45"], ["dk"], ["danmark"]),
  c("EE", "Estonia", ["+372"], ["ee"], ["eesti"]),
  c("FI", "Finland", ["+358"], ["fi"], ["suomi", "aland islands", "åland islands"]),
  c("FR", "France", ["+33"], ["fr"]),
  c("DE", "Germany", ["+49"], ["de"], ["deutschland"]),
  c("GR", "Greece", ["+30"], ["gr"], ["hellas"]),
  c("HU", "Hungary", ["+36"], ["hu"], ["magyarorszag", "magyarország"]),
  c("IE", "Ireland", ["+353"], ["ie"], ["republic of ireland", "eire"]),
  c("IT", "Italy", ["+39"], ["it"], ["italia"]),
  c("LV", "Latvia", ["+371"], ["lv"]),
  c("LT", "Lithuania", ["+370"], ["lt"]),
  c("LU", "Luxembourg", ["+352"], ["lu"]),
  c("MT", "Malta", ["+356"], ["mt"]),
  c("NL", "Netherlands", ["+31"], ["nl"], ["the netherlands", "holland"]),
  c("PL", "Poland", ["+48"], ["pl"], ["polska"]),
  c("PT", "Portugal", ["+351"], ["pt"]),
  c("RO", "Romania", ["+40"], ["ro"]),
  c("SK", "Slovakia", ["+421"], ["sk"]),
  c("SI", "Slovenia", ["+386"], ["si"]),
  c("ES", "Spain", ["+34"], ["es"], ["espana", "españa"]),
  c("SE", "Sweden", ["+46"], ["se"], ["sverige"]),
  c("IS", "Iceland", ["+354"], ["is"]),
  c("LI", "Liechtenstein", ["+423"], ["li"]),
  c("NO", "Norway", ["+47"], ["no"], ["norge"]),
  c("GB", "United Kingdom", ["+44"], ["uk"], ["uk", "great britain", "britain", "england", "scotland", "wales", "northern ireland"]),
  c("GG", "Guernsey", [], ["gg"]),
  c("JE", "Jersey", [], ["je"]),
  c("IM", "Isle of Man", [], ["im"]),
  c("GI", "Gibraltar", ["+350"], ["gi"]),
  // EU outermost regions with their own codes (France): Reunion and Mayotte, Guadeloupe, French Guiana, Martinique.
  c("RE", "Reunion", ["+262"], ["re"], ["réunion"]),
  c("YT", "Mayotte", [], ["yt"]),
  c("GP", "Guadeloupe", ["+590"], ["gp"]),
  c("MF", "Saint Martin", [], ["mf"]),
  c("BL", "Saint Barthelemy", [], ["bl"], ["saint barthélemy"]),
  c("GF", "French Guiana", ["+594"], ["gf"]),
  c("MQ", "Martinique", ["+596"], ["mq"]),
]);
// The EU itself has a TLD that belongs to no country.
const EXTRA_TLDS = Object.freeze(["eu"]);

export const REFUSED_COUNTRY_CODES: ReadonlySet<string> = new Set(ENRICHMENT_REFUSED_REGION.map((country) => country.code));
export const REFUSED_PHONE_PREFIXES: readonly string[] = Object.freeze(ENRICHMENT_REFUSED_REGION.flatMap((country) => [...country.prefixes]));
export const REFUSED_TLDS: ReadonlySet<string> = new Set([...ENRICHMENT_REFUSED_REGION.flatMap((country) => [...country.tlds]), ...EXTRA_TLDS]);

export type RegionVerdict = "blocked" | "outside" | "unknown";

export function phoneInRefusedRegion(phone: string | null): boolean {
  // E.164 country codes are prefix-free, so a plain prefix test cannot hit another country.
  return !!phone && REFUSED_PHONE_PREFIXES.some((prefix) => phone.startsWith(prefix));
}
export function domainInRefusedRegion(domain: string | null): boolean {
  if (!domain) return false;
  const labels = domain.toLowerCase().split(".");
  return labels.length > 1 && REFUSED_TLDS.has(labels[labels.length - 1]!);
}

const norm = (text: string) => text.trim().toLowerCase().normalize("NFC");
const NAMES: ReadonlyMap<string, string> = new Map(ENRICHMENT_REFUSED_REGION.flatMap((country) =>
  [norm(country.name), ...country.aliases.map(norm)].map((name) => [name, country.code] as const)));

/**
 * E-13: the refused country a free-text location names, or null. A part of the text that is a country
 * name, or the last part when it is a country code ("Lyon, FR"), counts. A US state that shares a code
 * with a refused country (Delaware is DE) is read as the country: refusing too much is the safe error.
 */
export function refusedCountryInLocation(location: string): string | null {
  const parts = location.split(/[,;|\n]/).map(norm).filter(Boolean);
  for (const part of parts) {
    const byName = NAMES.get(part);
    if (byName) return byName;
  }
  const last = parts[parts.length - 1]?.toUpperCase();
  return last && REFUSED_COUNTRY_CODES.has(last) ? last : null;
}

export interface RegionSignals {
  readonly phone: string | null;
  readonly country: string | null;
  readonly companyDomain: string | null;
  readonly emailDomain: string | null;
  readonly attested: boolean;
}

/** E-7: the signals in the contract's order; an owner mark never overrides a region signal. */
export function regionVerdict(signals: RegionSignals): RegionVerdict {
  if (phoneInRefusedRegion(signals.phone)
    || (signals.country !== null && REFUSED_COUNTRY_CODES.has(signals.country))
    || domainInRefusedRegion(signals.companyDomain) || domainInRefusedRegion(signals.emailDomain)) return "blocked";
  if (signals.phone !== null || signals.country !== null || signals.attested) return "outside";
  return "unknown";
}
