import { hasAnalyticsConsent } from './consent';

const POSTHOG_ALIAS_STORAGE_KEY = 'boardsesh:posthog-aliases';
const MAX_STORED_ALIAS_PAIRS = 64;

function aliasPairKey(profileId: string, userId: string): string {
  return `${profileId}->${userId}`;
}

function readAliasKeys(): string[] {
  if (typeof window === 'undefined') return [];

  try {
    // Synchronous localStorage is intentional: alias dedupe must run before
    // IndexedDB helpers are available during the identity effect.
    // oxlint-disable-next-line no-restricted-globals -- alias dedupe must persist across reloads before IndexedDB helpers are ready
    const raw = window.localStorage.getItem(POSTHOG_ALIAS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];

    const aliases: string[] = [];
    const seen = new Set<string>();
    for (const value of parsed) {
      if (typeof value !== 'string' || seen.has(value)) continue;
      seen.add(value);
      aliases.push(value);
    }

    return aliases.slice(-MAX_STORED_ALIAS_PAIRS);
  } catch {
    return [];
  }
}

export function hasRecordedPosthogAlias(profileId: string, userId: string): boolean {
  // No aliases exist (or matter) when analytics is denied/undecided — the
  // identity effect short-circuits before it can call `alias()`. Returning
  // false here keeps callers consistent without reading storage.
  if (!hasAnalyticsConsent()) return false;
  return readAliasKeys().includes(aliasPairKey(profileId, userId));
}

export function recordPosthogAlias(profileId: string, userId: string): void {
  if (typeof window === 'undefined') return;
  // No-op when the user hasn't granted analytics consent. The alias() call
  // itself is gated upstream, but this is a defense-in-depth guard so we
  // don't write dedupe entries for events we never sent.
  if (!hasAnalyticsConsent()) return;

  try {
    const pairKey = aliasPairKey(profileId, userId);
    const aliases = readAliasKeys().filter((aliasKey) => aliasKey !== pairKey);
    aliases.push(pairKey);
    const boundedAliases = aliases.slice(-MAX_STORED_ALIAS_PAIRS);
    // Keep this write synchronous so a successful alias is marked before any
    // later identity effect can retry the same pair.
    // oxlint-disable-next-line no-restricted-globals -- alias dedupe must persist across reloads before IndexedDB helpers are ready
    window.localStorage.setItem(POSTHOG_ALIAS_STORAGE_KEY, JSON.stringify(boundedAliases));
  } catch {
    // Best-effort only: if storage is blocked, the in-memory guard still
    // prevents duplicate aliases during this page lifetime.
  }
}
