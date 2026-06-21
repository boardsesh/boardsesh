// User's explicit language choice, layered on top of the device locale that
// `detectDeviceLocale()` picks at launch. `'system'` (or absent) means follow
// the device; a concrete locale forces that language. Persisted via SecureStore
// so the pick survives a cold start — without it, the app re-detects from the
// device every launch and any override is lost.
//
// Mobile-only on purpose: the web app carries locale in the URL prefix + a
// cookie (a different shape), so this does NOT live in
// `@boardsesh/key-value-storage`. The storage key uses only [\w.-] to satisfy
// expo-secure-store's validator (`:` and other punctuation throw at the
// platform boundary), matching THEME_OVERRIDE_KEY's constraint.

import { SUPPORTED_LOCALES, type Locale } from '@boardsesh/i18n';
import { secureStorePreferences } from '../preferences/secure-store-adapter';
import { SCREENSHOT_LOCALE_OVERRIDE } from '../screenshot-mode';
import { detectDeviceLocale } from './config';

export const LOCALE_OVERRIDE_KEY = 'locale_override';

export type LocaleOverride = 'system' | Locale;

export function isLocaleOverride(value: unknown): value is LocaleOverride {
  return value === 'system' || (typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value));
}

/**
 * Resolve an override to the concrete language i18next should run in.
 * `'system'` follows the device; an explicit locale passes through.
 */
export function resolveLanguage(override: LocaleOverride): Locale {
  if (SCREENSHOT_LOCALE_OVERRIDE) {
    return SCREENSHOT_LOCALE_OVERRIDE;
  }
  return override === 'system' ? detectDeviceLocale() : override;
}

/** Read the persisted override, defaulting to `'system'` when absent/malformed. */
export async function getStoredLocaleOverride(): Promise<LocaleOverride> {
  if (SCREENSHOT_LOCALE_OVERRIDE) {
    return SCREENSHOT_LOCALE_OVERRIDE;
  }
  const stored = await secureStorePreferences.get<LocaleOverride>(LOCALE_OVERRIDE_KEY);
  return isLocaleOverride(stored) ? stored : 'system';
}

export async function setStoredLocaleOverride(override: LocaleOverride): Promise<void> {
  await secureStorePreferences.set(LOCALE_OVERRIDE_KEY, override);
}
