// Catalog of filter controls a user can pin to the persistent chip row as a
// shortcut. The filter *dialog* is the canonical full set; the chip row is the
// user's pinned subset (see #3768). This module is the single source of truth
// for which controls are pinnable, their fixed render order, the defaults, and
// how each maps to the filter-token "receipt" row — all pure, so it's shared by
// the store (pinned-chips-store.ts), the chip row, the sheet's pin toggles, and
// the climbs screen's token dedup without pulling in React or native deps.
//
// v1 covers only controls that already render as chips. Adding the sheet-only
// controls (setters, holds, zones, beta, sort, grade accuracy, climb type,
// drafts) is a fast-follow that extends this catalog + a ChipDescriptor render.

export const PINNABLE_CHIP_KINDS = ['grade', 'progress', 'benchmarks', 'shape', 'popularity', 'rating'] as const;

export type PinnableChipKind = (typeof PINNABLE_CHIP_KINDS)[number];

// Fixed canonical order the chips render in, regardless of pin/unpin sequence.
// Matches today's hardcoded chip-row order so the default (all pinned) set is
// visually identical to the current app.
export const PINNABLE_CHIP_CATALOG: readonly PinnableChipKind[] = PINNABLE_CHIP_KINDS;

// Default pins = the whole catalog, so existing users see exactly today's row
// until they opt to unpin something.
export const DEFAULT_PINNED_CHIPS: readonly PinnableChipKind[] = PINNABLE_CHIP_CATALOG;

// Chips whose control is auth-gated (hidden when signed out), mirroring the
// sheet + the chip row's `canFilterProgress`. The pin persists; only rendering
// is gated.
export const AUTH_GATED_CHIPS: ReadonlySet<PinnableChipKind> = new Set<PinnableChipKind>(['progress']);

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
    case 'progress':
      return ['progress'];
    case 'benchmarks':
      return ['benchmark'];
    case 'shape':
      return ['tall', 'wide'];
    case 'popularity':
      return ['minAscents'];
    case 'rating':
      return ['minRating'];
  }
}
