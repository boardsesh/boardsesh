// Maps one device language tag onto an app locale. Pure and free of i18next and
// the catalogs, so every tag the fleet reports can be unit-tested on its own.
//
// Chinese is why this is not a one-line prefix match. `zh` covers two written
// languages: Simplified (script `Hans`) and Traditional (`Hant`). The app ships
// Simplified only, and a Traditional reader is better served by English than by
// the other script. A prefix match on the language code would hand `zh-Hans` to
// `zh-Hant-TW` and `zh-HK` alike.
//
// Tags seen from real devices: iOS sends `zh-Hans-CN`, `zh-Hans-US` and now and
// then a bare `zh-Hans`; Android sends both `zh-CN` and `zh-Hans-CN`, sometimes
// with a Unicode extension (`zh-Hans-CN-u-mu-celsius`).

import { SUPPORTED_LOCALES, type Locale } from '@boardsesh/i18n';

const SIMPLIFIED_CHINESE: Locale = 'zh-Hans';

/**
 * Regions that write Traditional Chinese when the tag names no script. Every
 * other region (and a bare `zh`) reads as Simplified, which is what CLDR's
 * likely-subtags table resolves `zh` to.
 */
const TRADITIONAL_CHINESE_REGIONS: ReadonlySet<string> = new Set(['TW', 'HK', 'MO']);

interface ParsedLanguageTag {
  language: string;
  script: string | null;
  region: string | null;
}

/**
 * The language, script and region of a BCP 47 tag. Parsing stops at the first
 * singleton (`-u-…`, `-x-…`), so an extension can never be mistaken for a region.
 */
function parseLanguageTag(languageTag: string): ParsedLanguageTag {
  const [language = '', ...rest] = languageTag.replace(/_/g, '-').split('-');
  let script: string | null = null;
  let region: string | null = null;
  for (const subtag of rest) {
    if (subtag.length === 1) break;
    if (script === null && region === null && /^[A-Za-z]{4}$/.test(subtag)) {
      script = subtag;
    } else if (region === null && /^(?:[A-Za-z]{2}|\d{3})$/.test(subtag)) {
      region = subtag.toUpperCase();
    }
  }
  return { language: language.toLowerCase(), script, region };
}

function isSupported(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * The app locale for one device language tag, or `null` when the app has no
 * translation for it (the caller then tries the device's next preferred
 * language, and English after that).
 */
export function matchDeviceLocale(languageTag: string | null | undefined): Locale | null {
  if (!languageTag) return null;
  if (isSupported(languageTag)) return languageTag;

  const { language, script, region } = parseLanguageTag(languageTag);
  if (!language) return null;

  if (language === 'zh') {
    const simplified =
      script !== null ? script.toLowerCase() === 'hans' : region === null || !TRADITIONAL_CHINESE_REGIONS.has(region);
    return simplified ? SIMPLIFIED_CHINESE : null;
  }

  return SUPPORTED_LOCALES.find((locale) => locale === language || locale.startsWith(`${language}-`)) ?? null;
}
