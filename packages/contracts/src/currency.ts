import { z } from "zod";

/**
 * The ISO 4217 currencies a business or a deal value may use (business-profile.md BP-4, inbox-home.md
 * H-1): circulating currencies, recently withdrawn ones and the IMF's units, without fund, metal, test
 * or "no currency" codes. The list is pinned here, not read from the runtime's `Intl`, so the API and
 * every browser agree. Names are English. Migrations 20261022520000_deal_currency_iso.sql and
 * 20261023100000_business_profiles.sql check the same codes; a test keeps them in step.
 */
export const CURRENCIES: readonly { readonly code: string; readonly name: string }[] = Object.freeze(([
  ["AED", "UAE Dirham"], ["AFN", "Afghan Afghani"], ["ALL", "Albanian Lek"], ["AMD", "Armenian Dram"],
  ["ANG", "Netherlands Antillean Guilder"], ["AOA", "Angolan Kwanza"], ["ARS", "Argentine Peso"],
  ["AUD", "Australian Dollar"], ["AWG", "Aruban Florin"], ["AZN", "Azerbaijani Manat"],
  ["BAM", "Bosnia-Herzegovina Convertible Mark"], ["BBD", "Barbadian Dollar"], ["BDT", "Bangladeshi Taka"],
  ["BGN", "Bulgarian Lev"], ["BHD", "Bahraini Dinar"], ["BIF", "Burundian Franc"], ["BMD", "Bermudian Dollar"],
  ["BND", "Brunei Dollar"], ["BOB", "Bolivian Boliviano"], ["BRL", "Brazilian Real"], ["BSD", "Bahamian Dollar"],
  ["BTN", "Bhutanese Ngultrum"], ["BWP", "Botswana Pula"], ["BYN", "Belarusian Ruble"], ["BZD", "Belize Dollar"],
  ["CAD", "Canadian Dollar"], ["CDF", "Congolese Franc"], ["CHF", "Swiss Franc"], ["CLP", "Chilean Peso"],
  ["CNY", "Chinese Yuan"], ["COP", "Colombian Peso"], ["CRC", "Costa Rican Colon"], ["CUC", "Cuban Convertible Peso"],
  ["CUP", "Cuban Peso"], ["CVE", "Cape Verdean Escudo"], ["CZK", "Czech Koruna"], ["DJF", "Djiboutian Franc"],
  ["DKK", "Danish Krone"], ["DOP", "Dominican Peso"], ["DZD", "Algerian Dinar"], ["EGP", "Egyptian Pound"],
  ["ERN", "Eritrean Nakfa"], ["ETB", "Ethiopian Birr"], ["EUR", "Euro"], ["FJD", "Fijian Dollar"],
  ["FKP", "Falkland Islands Pound"], ["GBP", "British Pound"], ["GEL", "Georgian Lari"], ["GHS", "Ghanaian Cedi"],
  ["GIP", "Gibraltar Pound"], ["GMD", "Gambian Dalasi"], ["GNF", "Guinean Franc"], ["GTQ", "Guatemalan Quetzal"],
  ["GYD", "Guyanese Dollar"], ["HKD", "Hong Kong Dollar"], ["HNL", "Honduran Lempira"], ["HRK", "Croatian Kuna"],
  ["HTG", "Haitian Gourde"], ["HUF", "Hungarian Forint"], ["IDR", "Indonesian Rupiah"], ["ILS", "Israeli New Shekel"],
  ["INR", "Indian Rupee"], ["IQD", "Iraqi Dinar"], ["IRR", "Iranian Rial"], ["ISK", "Icelandic Krona"],
  ["JMD", "Jamaican Dollar"], ["JOD", "Jordanian Dinar"], ["JPY", "Japanese Yen"], ["KES", "Kenyan Shilling"],
  ["KGS", "Kyrgyzstani Som"], ["KHR", "Cambodian Riel"], ["KMF", "Comorian Franc"], ["KPW", "North Korean Won"],
  ["KRW", "South Korean Won"], ["KWD", "Kuwaiti Dinar"], ["KYD", "Cayman Islands Dollar"], ["KZT", "Kazakhstani Tenge"],
  ["LAK", "Lao Kip"], ["LBP", "Lebanese Pound"], ["LKR", "Sri Lankan Rupee"], ["LRD", "Liberian Dollar"],
  ["LSL", "Lesotho Loti"], ["LYD", "Libyan Dinar"], ["MAD", "Moroccan Dirham"], ["MDL", "Moldovan Leu"],
  ["MGA", "Malagasy Ariary"], ["MKD", "Macedonian Denar"], ["MMK", "Myanmar Kyat"], ["MNT", "Mongolian Tugrik"],
  ["MOP", "Macanese Pataca"], ["MRU", "Mauritanian Ouguiya"], ["MUR", "Mauritian Rupee"], ["MVR", "Maldivian Rufiyaa"],
  ["MWK", "Malawian Kwacha"], ["MXN", "Mexican Peso"], ["MYR", "Malaysian Ringgit"], ["MZN", "Mozambican Metical"],
  ["NAD", "Namibian Dollar"], ["NGN", "Nigerian Naira"], ["NIO", "Nicaraguan Cordoba"], ["NOK", "Norwegian Krone"],
  ["NPR", "Nepalese Rupee"], ["NZD", "New Zealand Dollar"], ["OMR", "Omani Rial"], ["PAB", "Panamanian Balboa"],
  ["PEN", "Peruvian Sol"], ["PGK", "Papua New Guinean Kina"], ["PHP", "Philippine Peso"], ["PKR", "Pakistani Rupee"],
  ["PLN", "Polish Zloty"], ["PYG", "Paraguayan Guarani"], ["QAR", "Qatari Riyal"], ["RON", "Romanian Leu"],
  ["RSD", "Serbian Dinar"], ["RUB", "Russian Ruble"], ["RWF", "Rwandan Franc"], ["SAR", "Saudi Riyal"],
  ["SBD", "Solomon Islands Dollar"], ["SCR", "Seychellois Rupee"], ["SDG", "Sudanese Pound"], ["SEK", "Swedish Krona"],
  ["SGD", "Singapore Dollar"], ["SHP", "Saint Helena Pound"], ["SLE", "Sierra Leonean Leone"],
  ["SLL", "Sierra Leonean Leone (old)"], ["SOS", "Somali Shilling"], ["SRD", "Surinamese Dollar"],
  ["SSP", "South Sudanese Pound"], ["STN", "Sao Tome and Principe Dobra"], ["SVC", "Salvadoran Colon"],
  ["SYP", "Syrian Pound"], ["SZL", "Swazi Lilangeni"], ["THB", "Thai Baht"], ["TJS", "Tajikistani Somoni"],
  ["TMT", "Turkmenistani Manat"], ["TND", "Tunisian Dinar"], ["TOP", "Tongan Paanga"], ["TRY", "Turkish Lira"],
  ["TTD", "Trinidad and Tobago Dollar"], ["TWD", "New Taiwan Dollar"], ["TZS", "Tanzanian Shilling"],
  ["UAH", "Ukrainian Hryvnia"], ["UGX", "Ugandan Shilling"], ["USD", "US Dollar"], ["UYU", "Uruguayan Peso"],
  ["UZS", "Uzbekistani Som"], ["VED", "Venezuelan Digital Bolivar"], ["VES", "Venezuelan Bolivar"],
  ["VND", "Vietnamese Dong"], ["VUV", "Vanuatu Vatu"], ["WST", "Samoan Tala"], ["XAF", "Central African CFA Franc"],
  ["XCD", "East Caribbean Dollar"], ["XCG", "Caribbean Guilder"], ["XDR", "Special Drawing Rights"],
  ["XOF", "West African CFA Franc"], ["XPF", "CFP Franc"], ["XSU", "Sucre"], ["YER", "Yemeni Rial"],
  ["ZAR", "South African Rand"], ["ZMW", "Zambian Kwacha"], ["ZWG", "Zimbabwe Gold"], ["ZWL", "Zimbabwean Dollar (old)"],
] as const).map(([code, name]) => Object.freeze({ code, name })));

/** H-1: the codes alone, sorted. */
export const CURRENCY_CODES: readonly string[] = Object.freeze(CURRENCIES.map((currency) => currency.code));
const currencyCodes: ReadonlySet<string> = new Set(CURRENCY_CODES);
const currencyNames: ReadonlyMap<string, string> = new Map(CURRENCIES.map((currency) => [currency.code, currency.name]));

/** Whether `code` is on the pinned list. */
export const isCurrencyCode = (code: string): boolean => currencyCodes.has(code);
/** BP-8: "EUR · Euro". A code off the list shows as itself. */
export function currencyLabel(code: string): string {
  const name = currencyNames.get(code);
  return name === undefined ? code : `${code} · ${name}`;
}

export const currencyCodeSchema = z.string().refine(isCurrencyCode, "Expected an ISO 4217 code such as USD");
/**
 * H-1 revision 4: a currency as reads show it. Deals stored under the earlier check may hold any
 * three capitals until the owner fixes them, so reads accept that shape; writes take only
 * currencyCodeSchema.
 */
export const storedCurrencyCodeSchema = z.string().regex(/^[A-Z]{3}$/, "Expected three capital letters");
