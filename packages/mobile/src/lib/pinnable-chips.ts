// Catalog of filter controls a user can pin to the persistent chip row as a
// shortcut. The filter *dialog* is the canonical full set; the chip row is the
// user's pinned subset (see #3768), in the user's own order (Settings › Climbs &
// grades › Quick filters). This module is the single source of truth for which
// controls are pinnable, the order a fresh install starts in, the defaults, and
// how each maps to the filter-token "receipt" row — all pure, so it's shared by
// the store (pinned-chips-store.ts), the chip row, the sheet's pin toggles, the
// Quick filters page and the climbs screen's token dedup without pulling in
// React or native deps.
//
// The catalog grows one tier at a time. Tier 1 (grade…rating) are the controls
// that already rendered as chips. Tier 2 adds the self-contained sheet-only
// controls — sort, grade accuracy, climb type, beta — as opt-in chips (they are
// NOT in the defaults, so the row is unchanged until a user pins one). The
// remaining sheet-only controls (setters, holds, zones) are a later fast-follow
// because they open a full picker rather than switching a value in place.
//
// 'recent' is the saved-searches menu. It backs no filter, and it shows
// only while there are saved searches, but it pins like any chip so a climber
// who never uses it can hide it. It is pinned by default, and a list saved
// before it was pinnable gains it on load (see fromStoredPinnedChips).

export const PINNABLE_CHIP_KINDS = [
  'recent',
  'grade',
  'accuracy',
  'progress',
  'collection',
  'climbType',
  'tall',
  'wide',
  'beta',
  'popularity',
  'rating',
  'sort',
] as const;

export type PinnableChipKind = (typeof PINNABLE_CHIP_KINDS)[number];

/**
 * Every chip a capsule row or the filter sheet can pin, across surfaces: the
 * climbs list's kinds plus "Fits my board", which only a playlist offers (see
 * lib/playlist-pinnable-chips.ts). The climbs catalog above stays as it is, so a
 * climbs pin set can never hold a playlist-only kind.
 */
export type FilterChipKind = PinnableChipKind | 'boardFit';

// Every pinnable kind in the sheet's order: the order the defaults render in and
// the order unpinned kinds list in on the Quick filters page. Pinned chips render
// in the order the climber saved, not this one; a newly pinned chip goes last.
// Recent leads, right after the fixed Filters button, as it always has. The rest
// mirror the sheet's section order: accuracy sits by grade, climbType by
// Tall/Wide (all "The Climb"), beta after Wide, sort last.
export const PINNABLE_CHIP_CATALOG: readonly PinnableChipKind[] = PINNABLE_CHIP_KINDS;

// Default pins = Recent plus exactly the Tier-1 chips, so existing users see the
// same row they have today. The Tier-2 controls (accuracy, climbType, beta,
// sort) are pinnable but opt-in — unpinned until a user turns them on in the
// sheet.
export const DEFAULT_PINNED_CHIPS: readonly PinnableChipKind[] = [
  'recent',
  'grade',
  'progress',
  'collection',
  'tall',
  'wide',
  'popularity',
  'rating',
];

// Auth-gating (progress + My drafts hide when signed out) is applied at the chip
// row via the `canFilterProgress` / `canFilterPersonalCollections` props, not here — the pin
// itself always persists, only rendering is gated.

export function isValidChipKind(value: unknown): value is PinnableChipKind {
  return typeof value === 'string' && (PINNABLE_CHIP_KINDS as readonly string[]).includes(value);
}

// Retired kinds a stored pin set may still hold, mapped to the kinds that
// replaced them. 'shape' was one menu chip grouping Tall + Wide (#3802); they're
// separate chips again (#5659), so a saved 'shape' pin becomes both — nobody who
// had the Shape chip loses Tall or Wide after the update. The mapping runs on
// every load (storage is never rewritten just to migrate).
const LEGACY_SHAPE_KIND = 'shape';
const LEGACY_CHIP_KINDS: ReadonlyMap<unknown, readonly PinnableChipKind[]> = new Map<
  unknown,
  readonly PinnableChipKind[]
>([[LEGACY_SHAPE_KIND, ['tall', 'wide']]]);

/**
 * Returns pins in the order they were saved, stripped of unknown kinds and
 * repeats (the first one wins), with retired kinds mapped to their replacements
 * where they stood (a stored 'shape' becomes 'tall' + 'wide'). A replacement the
 * payload also names on its own keeps that place instead, so the rollback alias
 * {@link toStoredPinnedChips} writes never moves Tall or Wide. Unknown kinds
 * dropping out makes a stored payload safe to grow the catalog.
 */
export function normalizePinnedChips(kinds: readonly unknown[]): PinnableChipKind[] {
  const named = new Set(kinds.filter(isValidChipKind));
  const expanded = kinds.flatMap<unknown>((kind) => {
    const replacements = LEGACY_CHIP_KINDS.get(kind);
    return replacements ? replacements.filter((replacement) => !named.has(replacement)) : [kind];
  });
  return [...new Set(expanded.filter(isValidChipKind))];
}

/**
 * Saved in place of 'recent' when the climber has unpinned Recent. A list saved
 * before Recent was pinnable has neither, so the two cases stay apart: the
 * marker means "hidden on purpose", no mention means "an older list, keep
 * today's Recent". It is not a valid kind, so {@link normalizePinnedChips} and
 * every older bundle drop it.
 */
export const RECENT_UNPINNED_MARKER = '!recent';

/**
 * Loads a stored pin payload. Same as {@link normalizePinnedChips}, plus one
 * migration: a list saved before Recent was pinnable (it holds neither 'recent'
 * nor {@link RECENT_UNPINNED_MARKER}) gains 'recent' first, where the chip has
 * always drawn, so nobody loses it by updating. Nothing valid left returns `[]`,
 * so the store still falls back to the full defaults instead of a row of Recent
 * alone. Load-only: running it on a fresh pin change would re-add a Recent the
 * climber just unpinned.
 */
export function fromStoredPinnedChips(stored: readonly unknown[]): PinnableChipKind[] {
  const pins = normalizePinnedChips(stored);
  if (pins.length === 0) return pins;
  const savedBeforeRecentPin = !stored.includes('recent') && !stored.includes(RECENT_UNPINNED_MARKER);
  return savedBeforeRecentPin ? ['recent', ...pins] : pins;
}

/**
 * The payload to persist for a pinned set, in the climber's order. When BOTH Tall
 * and Wide are pinned it also carries the retired 'shape' kind right after
 * 'wide', so an older bundle that only knows the Shape menu chip (a tester
 * switching back from a PR preview, an OTA rollback, or the store binary's
 * embedded fallback) still shows it. {@link normalizePinnedChips} ignores that
 * 'shape' while Tall and Wide are named, so this bundle keeps both where they
 * are. With only one of them pinned there's no 'shape': writing it would make
 * this bundle re-add the one the user unpinned.
 *
 * Older bundles read the kinds they know in their catalog order: they lose the
 * custom order, never a pin, and nothing here throws for them.
 *
 * With Recent unpinned it ends with {@link RECENT_UNPINNED_MARKER}, so the next
 * load keeps Recent hidden instead of treating the list as one saved before
 * Recent was pinnable.
 */
export function toStoredPinnedChips(kinds: readonly PinnableChipKind[]): string[] {
  const stored: string[] =
    kinds.includes('tall') && kinds.includes('wide')
      ? kinds.flatMap((kind) => (kind === 'wide' ? [kind, LEGACY_SHAPE_KIND] : [kind]))
      : [...kinds];
  if (!kinds.includes('recent')) stored.push(RECENT_UNPINNED_MARKER);
  return stored;
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
export function chipKindToTokenKeys(kind: FilterChipKind): readonly string[] {
  switch (kind) {
    case 'recent':
      // Saved searches, not a filter: there is no token to claim.
      return [];
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
      // The onlyBenchmarks and Liked tokens. The Collection chip also owns My
      // drafts (status='drafts'), whose token key `status` is shared with the
      // Popularity group's "Unrepeated" (status='projects'), so it's left
      // unclaimed here — a drafts token can still show alongside a pinned
      // Collection chip (rare).
      return ['benchmark', 'liked'];
    case 'tall':
      return ['tall'];
    case 'wide':
      return ['wide'];
    case 'popularity':
      return ['minAscents'];
    case 'rating':
      return ['minRating'];
    case 'boardFit':
      return ['boardFit'];
  }
}
