// The 2.7 preview-first spotlight pinned above the What's New timeline: "Look
// through climbs without lighting the board", for climbers who read release
// notes. Pinned, like the offline spotlight, because the generated timeline is
// rebuilt from PR release notes on every build and is English-only.
//
// It retires when the climber dismisses it, or 30 days after it first showed:
// past a month it is no longer news. Until it has shown once it also lights the
// What's New row's "New" pill (`hasUnseenPreviewFirstSpotlight`), or nobody whose
// changelog was already read would ever open the screen to find it.

import { CHANGELOG_PREVIEW_FIRST_SPOTLIGHT_KEY } from '@boardsesh/key-value-storage';
import { secureStorePreferences } from './preferences/secure-store-adapter';

/** How long after it first showed the spotlight stays pinned. */
export const PREVIEW_FIRST_SPOTLIGHT_DAYS = 30;
const PREVIEW_FIRST_SPOTLIGHT_MS = PREVIEW_FIRST_SPOTLIGHT_DAYS * 24 * 60 * 60 * 1000;

export type PreviewFirstSpotlightRecord = {
  /** `Date.now()` when it first showed; null before that. */
  shownAt: number | null;
  dismissed: boolean;
};

const NEVER_SHOWN: PreviewFirstSpotlightRecord = { shownAt: null, dismissed: false };

function isRecord(value: unknown): value is PreviewFirstSpotlightRecord {
  if (value === null || typeof value !== 'object') return false;
  const { shownAt, dismissed } = value as Record<string, unknown>;
  return (shownAt === null || typeof shownAt === 'number') && typeof dismissed === 'boolean';
}

/**
 * The stored record. A missing or malformed one reads as never shown. A read
 * error reads as dismissed: a card that keeps coming back on a flaky store is
 * worse than a missed one.
 */
export async function loadPreviewFirstSpotlight(): Promise<PreviewFirstSpotlightRecord> {
  try {
    const stored = await secureStorePreferences.get<unknown>(CHANGELOG_PREVIEW_FIRST_SPOTLIGHT_KEY);
    return isRecord(stored) ? stored : NEVER_SHOWN;
  } catch {
    return { shownAt: null, dismissed: true };
  }
}

/** Pure: whether the card is pinned right now. */
export function isPreviewFirstSpotlightActive(record: PreviewFirstSpotlightRecord, now: number): boolean {
  if (record.dismissed) return false;
  return record.shownAt === null || now - record.shownAt < PREVIEW_FIRST_SPOTLIGHT_MS;
}

/** Start the 30 days the first time it shows. Later shows keep the first date. */
export async function markPreviewFirstSpotlightShown(
  record: PreviewFirstSpotlightRecord,
  now: number,
): Promise<PreviewFirstSpotlightRecord> {
  if (record.shownAt !== null) return record;
  const next = { ...record, shownAt: now };
  await secureStorePreferences.set(CHANGELOG_PREVIEW_FIRST_SPOTLIGHT_KEY, next);
  return next;
}

export async function dismissPreviewFirstSpotlight(record: PreviewFirstSpotlightRecord): Promise<void> {
  await secureStorePreferences.set(CHANGELOG_PREVIEW_FIRST_SPOTLIGHT_KEY, { ...record, dismissed: true });
}

/**
 * Whether the What's New row deserves its "New" pill for this card: it has never
 * shown and was never dismissed. Screenshot mode reports false, matching
 * `hasUnseenChangelog`.
 */
export async function hasUnseenPreviewFirstSpotlight(): Promise<boolean> {
  if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') return false;
  const record = await loadPreviewFirstSpotlight();
  return !record.dismissed && record.shownAt === null;
}
