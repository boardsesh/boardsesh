/**
 * Where Boardsesh asks the analytics question.
 *
 * The prompt is shown in the places where GDPR, a law that copies it, or
 * another consent-based privacy law makes product analytics consent-based. Everywhere else analytics starts on as a
 * device-local default the climber can switch off in Settings (see
 * `createRegionDefaultConsent`). An unknown or unreadable location always asks:
 * when in doubt, prompt. See docs/analytics-consent.md.
 */

/** Narrow origin header overwritten by the configured Cloudflare edge rule. */
export const CONSENT_REGION_EDGE_HEADER_NAME = 'x-boardsesh-region-code';

/** The 27 EU member states. */
const EU_MEMBER_STATES = [
  'AT',
  'BE',
  'BG',
  'CY',
  'CZ',
  'DE',
  'DK',
  'EE',
  'ES',
  'FI',
  'FR',
  'GR',
  'HR',
  'HU',
  'IE',
  'IT',
  'LT',
  'LU',
  'LV',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SE',
  'SI',
  'SK',
] as const;

/**
 * EU territory that IP geolocation reports under its own ISO code: Åland
 * (Finland) and France's outermost regions. GDPR applies there as in the rest
 * of the member state.
 */
const EU_TERRITORIES_WITH_OWN_CODES = ['AX', 'GF', 'GP', 'MF', 'MQ', 'RE', 'YT'] as const;

/** EEA members outside the EU, which apply GDPR through the EEA Agreement. */
const EEA_NON_EU = ['IS', 'LI', 'NO'] as const;

/**
 * UK GDPR, and the places with their own GDPR-equivalent law: Switzerland
 * (revised FADP), Gibraltar (Gibraltar GDPR) and the Crown Dependencies
 * Guernsey, Jersey and the Isle of Man. These are a policy choice rather than
 * GDPR itself and can be dropped without touching the EU/EEA set.
 */
const GDPR_EQUIVALENT = ['CH', 'GB', 'GG', 'GI', 'IM', 'JE'] as const;

/**
 * Privacy laws built on consent rather than GDPR: China's PIPL has no
 * legitimate-interest basis, and South Korea's PIPA asks for consent to
 * collect personal information. Also a policy choice, kept apart so it can be
 * dropped. Quebec is handled by its trusted province code below.
 */
const CONSENT_BASED_LAWS = ['CN', 'KR'] as const;
/** Additional prompt jurisdictions selected by the owner. */
const ADDITIONAL_PROMPT_COUNTRIES = ['AD', 'MC', 'SM', 'VA', 'FO'] as const;

/** Canada's provinces and territories; unknown subdivisions fail closed. */
const CANADIAN_REGIONS: ReadonlySet<string> = new Set([
  'AB',
  'BC',
  'MB',
  'NB',
  'NL',
  'NS',
  'NT',
  'NU',
  'ON',
  'PE',
  'QC',
  'SK',
  'YT',
]);

/** Every ISO 3166-1 alpha-2 code whose visitors are asked before analytics runs. */
export const CONSENT_PROMPT_COUNTRIES: readonly string[] = [
  ...EU_MEMBER_STATES,
  ...EU_TERRITORIES_WITH_OWN_CODES,
  ...EEA_NON_EU,
  ...GDPR_EQUIVALENT,
  ...CONSENT_BASED_LAWS,
  ...ADDITIONAL_PROMPT_COUNTRIES,
];

const PROMPT_COUNTRY_SET: ReadonlySet<string> = new Set(CONSENT_PROMPT_COUNTRIES);
/**
 * ISO 3166-1 alpha-2 country codes (249 entries, checked 2026-10-12).
 * https://www.iso.org/obp/ui/#search/code/
 * Unknown, user-assigned (including XK) and reserved codes fail closed.
 */
const KNOWN_COUNTRY_CODES: ReadonlySet<string> = new Set(
  [
    'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW',
    'BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI',
    'FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN',
    'IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME',
    'MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF',
    'PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV',
    'SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE',
    'YT ZA ZM ZW',
  ]
    .join(' ')
    .split(' '),
);

/**
 * The country code when it names one real country, else null. Lowercase,
 * padded, Tor (`T1`), `XX` and anything else unexpected all come back null.
 */
export function normalizeConsentCountry(countryCode: string | null | undefined): string | null {
  return typeof countryCode === 'string' && KNOWN_COUNTRY_CODES.has(countryCode) ? countryCode : null;
}

/**
 * True when a visitor from this country has to be asked before analytics runs:
 * every code in {@link CONSENT_PROMPT_COUNTRIES}, and every code that does not
 * name one known country (null, `XX`, `ZZ`, `T1`, `EU`, lowercase, ...).
 * Recognised countries outside the list skip the prompt, except Canada:
 * it also requires a recognised province other than Quebec.
 */
export function consentPromptRequired(countryCode: string | null | undefined, regionCode?: string | null): boolean {
  const country = normalizeConsentCountry(countryCode);
  // Quebec asks. A missing or unknown Canadian province cannot rule it out.
  // The backend supplies this code only after trusting the Cloudflare edge.
  if (country === 'CA') return regionCode === 'QC' || !CANADIAN_REGIONS.has(regionCode ?? '');
  return country === null || PROMPT_COUNTRY_SET.has(country);
}
