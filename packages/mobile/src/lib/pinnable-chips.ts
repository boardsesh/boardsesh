// Catalog of filter controls a user can pin to the persistent chip row as a
// shortcut. The filter *dialog* is the canonical full set; the chip row is the
// user's pinned subset (see #3768). This module is the single source of truth
// for which controls are pinnable, their fixed render order, the defaults, and
// how each maps to the filter-token "receipt" row — all pure, so it's shared by
// the store (pinned-chips-store.ts), the chip row, the sheet's pin toggles, and
// the climbs screen's token dedup without pulling in React or native deps.
//
// The catalog grows one tier at a time. Tier 1 (grade…rating) are the controls
// that already rendered as chips. Tier 2 adds the self-contained sheet-only
// controls — sort, grade accuracy, climb type, beta — as opt-in chips (they are
// NOT in the defaults, so the row is unchanged until a user pins one). The
// remaining sheet-only controls (setters, holds, zones) are a later fast-follow
// because they open a full picker rather than switching a value in place.

export const PINNABLE_CHIP_KINDS = [
  'grade',
  'accuracy',
  'progress',
  'collection',
  'climbType',
  'shape',
  'beta',
  'popularity',
  'rating',
  'sort',
] as const;

export type PinnableChipKind = (typeof PINNABLE_CHIP_KINDS)[number];

// Fixed canonical order the chips render in, regardless of pin/unpin sequence.
// Grouped to mirror the sheet's section order: accuracy sits by grade, climbType
// by shape (both "The Climb"), beta after shape, sort last.
export const PINNABLE_CHIP_CATALOG: readonly PinnableChipKind[] = PINNABLE_CHIP_KINDS;

// Default pins = exactly the Tier-1 chips, so existing users see the same row
// they have today. The Tier-2 controls (accuracy, climbType, beta, sort) are
// pinnable but opt-in — unpinned until a user turns them on in the sheet.
export const DEFAULT_PINNED_CHIPS: readonly PinnableChipKind[] = [
  'grade',
  'progress',
  'collection',
  'shape',
  'popularity',
  'rating',
];

// Auth-gating (progress + My drafts hide when signed out) is applied at the chip
// row via the `canFilterProgress` / `canFilterDrafts` props, not here — the pin
// itself always persists, only rendering is gated.

export function isValidChipKind(value: unknown): value is PinnableChipKind {
  return typeof value === 'string' && (PINNABLE_CHIP_KINDS as readonly string[]).includes(value);
}

/**
 * Returns pins re-sorted into {@link PINNABLE_CHIP_CATALOG} order and stripped of
 * unknown/duplicate kinds. Keeps the fixed-order invariant no matter what order
 * kinds were toggled in, and makes a stored payload safe to grow the catalog.
 */
export function normalizePinnedChips(kinds: readonly unknown[]): PinnableChipKind[] {
  const set = new Set(kinds.filter(isValidChipKind));
  return PINNABLE_CHIP_CATALOG.filter((kind) => set.has(kind));
}

/**
 * The {@link FilterToken} keys (see lib/filter-tokens.ts) a pinned chip "backs" —
 * i.e. controls and clears — so the climbs screen can exclude them from the
 * removable token "receipt" row (no double-up). Unpinned-but-active filters keep
 * their token, so they stay visible and clearable.
 *
 * Note: the Popularity chip also owns "Unrepeated" (`status='projects'`), whose
 * token key is `status`; that key is intentionally NOT claimed here in v1 because
 * `status` is shared with "My drafts" (a sheet-only control). Matches today's
 * behaviour — flag in the PR.
 */
export function chipKindToTokenKeys(kind: PinnableChipKind): readonly string[] {
  switch (kind) {
    case 'grade':
      return ['grade'];
    case 'accuracy':
      return ['gradeAccuracy'];
    case 'climbType':
      return ['climbType'];
    case 'beta':
      return ['beta'];
    case 'sort':
      return ['sort'];
    case 'progress':
      return ['progress'];
    case 'collection':
      // The onlyBenchmarks token. The Collection chip also owns My drafts
      // (status='drafts'), whose token key `status` is shared with the Popularity
      // group's "Unrepeated" (status='projects'), so it's left unclaimed here — a
      // drafts token can still show alongside a pinned Collection chip (rare).
      return ['benchmark'];
    case 'shape':
      return ['tall', 'wide'];
    case 'popularity':
      return ['minAscents'];
    case 'rating':
      return ['minRating'];
  }
}
