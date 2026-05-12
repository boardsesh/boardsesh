/**
 * Shared i18n mock for unit tests.
 *
 * Tests in this repo render React components that use react-i18next's
 * `useTranslation` hook. Without an i18n provider, `t()` returns the bare
 * key, which breaks assertions that look for the rendered English string.
 *
 * This helper resolves keys against the real `en-US` JSON catalogs so tests
 * can keep asserting on the English copy a user actually sees, without each
 * test file having to register its own per-key translation map.
 *
 * Usage (top of test file):
 *
 *   import { vi } from 'vite-plus/test';
 *   import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
 *
 *   vi.mock('react-i18next', () => ({
 *     useTranslation: (ns?: string) => ({
 *       t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
 *       i18n: { language: 'en-US' },
 *     }),
 *     Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
 *   }));
 */

import enAdmin from '@/i18n/locales/en-US/admin.json';
import enAurora from '@/i18n/locales/en-US/aurora.json';
import enAuth from '@/i18n/locales/en-US/auth.json';
import enBoards from '@/i18n/locales/en-US/boards.json';
import enClimbs from '@/i18n/locales/en-US/climbs.json';
import enCommon from '@/i18n/locales/en-US/common.json';
import enFeed from '@/i18n/locales/en-US/feed.json';
import enGenerator from '@/i18n/locales/en-US/generator.json';
import enMarketing from '@/i18n/locales/en-US/marketing.json';
import enNotifications from '@/i18n/locales/en-US/notifications.json';
import enPlaylists from '@/i18n/locales/en-US/playlists.json';
import enProfile from '@/i18n/locales/en-US/profile.json';
import enSession from '@/i18n/locales/en-US/session.json';
import enSettings from '@/i18n/locales/en-US/settings.json';
import enYou from '@/i18n/locales/en-US/you.json';

const CATALOGS: Record<string, unknown> = {
  admin: enAdmin,
  aurora: enAurora,
  auth: enAuth,
  boards: enBoards,
  climbs: enClimbs,
  common: enCommon,
  feed: enFeed,
  generator: enGenerator,
  marketing: enMarketing,
  notifications: enNotifications,
  playlists: enPlaylists,
  profile: enProfile,
  session: enSession,
  settings: enSettings,
  you: enYou,
};

const DEFAULT_NAMESPACE = 'common';

function navigate(root: unknown, segments: string[]): unknown {
  let current: unknown = root;
  for (const segment of segments) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function interpolate(template: string, options?: Record<string, unknown>): string {
  if (!options) return template;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, name: string) => {
    const value = options[name];
    if (value === undefined || value === null) return `{{${name}}}`;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return JSON.stringify(value);
  });
}

/**
 * Resolve a translation key against the real en-US JSON catalogs.
 *
 * - Supports nested keys: `actions.tick.drawer.signInRequired`
 * - Honors i18next plural suffixes (`_one`, `_other`) when an integer `count`
 *   is provided
 * - Performs simple `{{var}}` interpolation
 * - Returns the bare key if nothing matches, mirroring i18next's fallback
 * - Accepts namespace as a string, an array (uses first entry), or undefined
 * - Honors `options.ns` overrides, mirroring `t(key, { ns: 'common' })`
 */
export function tFromCatalog(
  namespace: string | readonly string[] | undefined,
  key: string,
  options?: Record<string, unknown>,
): string {
  // Resolve namespace: explicit options.ns wins, then `ns:key` colon syntax,
  // then the namespace passed to useTranslation (string or first of array),
  // then the default.
  const optsNs = typeof options?.ns === 'string' ? (options.ns as string) : undefined;
  let resolvedNs: string;
  if (optsNs) {
    resolvedNs = optsNs;
  } else if (Array.isArray(namespace)) {
    resolvedNs = namespace[0] ?? DEFAULT_NAMESPACE;
  } else {
    resolvedNs = (namespace as string | undefined) ?? DEFAULT_NAMESPACE;
  }
  let resolvedKey = key;
  const colon = key.indexOf(':');
  if (colon > 0) {
    resolvedNs = key.slice(0, colon);
    resolvedKey = key.slice(colon + 1);
  }

  const catalog = CATALOGS[resolvedNs];
  if (!catalog) return key;

  const segments = resolvedKey.split('.');
  const lastIndex = segments.length - 1;

  // i18next pluralization: try `<key>_one` / `<key>_other` first when count is integer
  const count = options?.count;
  if (typeof count === 'number' && Number.isFinite(count)) {
    const suffix = count === 1 ? '_one' : '_other';
    const pluralSegments = [...segments];
    pluralSegments[lastIndex] = `${pluralSegments[lastIndex]}${suffix}`;
    const pluralValue = navigate(catalog, pluralSegments);
    if (typeof pluralValue === 'string') {
      return interpolate(pluralValue, options);
    }
  }

  const value = navigate(catalog, segments);
  if (typeof value === 'string') {
    return interpolate(value, options);
  }

  return key;
}
