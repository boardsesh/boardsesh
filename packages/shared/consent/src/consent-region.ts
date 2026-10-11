/**
 * Where Boardsesh asks the analytics question.
 *
 * The prompt is shown in the places where GDPR, or a law that copies it, makes
 * product analytics consent-based. Everywhere else analytics starts on as a
 * device-local default the climber can switch off in Settings (see
 * `createRegionDefaultConsent`). An unknown or unreadable location always asks:
 * when in doubt, prompt. See docs/analytics-consent.md.
 */

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

/** Every ISO 3166-1 alpha-2 code whose visitors are asked before analytics runs. */
export const CONSENT_PROMPT_COUNTRIES: readonly string[] = [
  ...EU_MEMBER_STATES,
  ...EU_TERRITORIES_WITH_OWN_CODES,
  ...EEA_NON_EU,
  ...GDPR_EQUIVALENT,
];

const PROMPT_COUNTRY_SET: ReadonlySet<string> = new Set(CONSENT_PROMPT_COUNTRIES);
const TWO_UPPERCASE_LETTERS = /^[A-Z]{2}$/;

/**
 * Codes that are two letters but name no single country: the ISO 3166-1
 * user-assigned range (AA, QM-QZ, XA-XZ, ZZ; geolocation uses XX and ZZ for
 * "unknown") and the exceptionally reserved EU and UK, which some lookups emit.
 */
function isNotACountry(code: string): boolean {
  return code === 'AA' || code === 'ZZ' || code === 'EU' || code === 'UK' || code[0] === 'X' || /^Q[M-Z]$/.test(code);
}

/**
 * The country code when it names one real country, else null. Lowercase,
 * padded, Tor (`T1`), `XX` and anything else unexpected all come back null.
 */
export function normalizeConsentCountry(countryCode: string | null | undefined): string | null {
  if (typeof countryCode !== 'string' || !TWO_UPPERCASE_LETTERS.test(countryCode)) return null;
  return isNotACountry(countryCode) ? null : countryCode;
}

/**
 * True when a visitor from this country has to be asked before analytics runs:
 * every code in {@link CONSENT_PROMPT_COUNTRIES}, and every code that does not
 * name one known country (null, `XX`, `ZZ`, `T1`, `EU`, lowercase, ...).
 * Only a recognised country outside the list skips the prompt.
 */
export function consentPromptRequired(countryCode: string | null | undefined): boolean {
  const country = normalizeConsentCountry(countryCode);
  return country === null || PROMPT_COUNTRY_SET.has(country);
}
