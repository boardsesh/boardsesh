import type { ClimbFilterState } from './filter-state';

/**
 * The user's relationship to a climb, expressed as a single choice — the model
 * behind the "Your progress" selector. It collapses the four independent tick
 * flags ({@link ProgressFlags}) into one mutually-exclusive lens, so a UI can
 * offer "All / Not tried / Projects / Sent / Unsent" instead of a bag of
 * switches that can silently contradict each other.
 *
 * All four flags query the per-user `boardsesh_ticks` table in
 * @boardsesh/db create-climb-filters.ts — there is no new query behind this,
 * only a cleaner front-end model over the existing levers:
 *
 * - `all`      — no progress constraint.
 * - `untried`  — no tick of any kind (never attempted, never sent).
 * - `projects` — attempted but not sent (the classic "project").
 * - `sent`     — flashed or sent.
 * - `unsent`   — everything not yet sent = `untried` ∪ `projects`. This is the
 *                behaviour of the old "Hide climbs I've sent" switch, kept so no
 *                one loses a filter they already rely on.
 *
 * Note `unsent` is a superset of `untried` and `projects`; that overlap is fine
 * for a single-select — each value is just a different view of the same axis.
 */
// Ordered for the UI: "All" and the broad "Unsent" (haven't sent) lead, then the
// journey narrows through "Not tried" → "Projects", ending on "Sent".
export const PROGRESS_FILTER_VALUES = ['all', 'unsent', 'untried', 'projects', 'sent'] as const;
export type ProgressFilter = (typeof PROGRESS_FILTER_VALUES)[number];

/** The four per-user tick flags this selector owns. */
export type ProgressFlags = Pick<
  ClimbFilterState,
  'hideAttempted' | 'hideCompleted' | 'showOnlyAttempted' | 'showOnlyCompleted'
>;

/**
 * The patch shape {@link progressToFlags} returns: every flag key present, each
 * either `true` or `undefined`. Written as a `Record` rather than
 * `Required<ProgressFlags>` because `Required` (and the `-?` modifier) strip
 * `undefined` from the value — leaving `boolean` and rejecting the explicit
 * `undefined` clears below. Keys stay required so a spread reliably overwrites
 * stale flags.
 */
export type ProgressFlagsPatch = Record<keyof ProgressFlags, boolean | undefined>;

/**
 * The flag patch for a given progress choice. Every key is present (set to
 * `undefined` when off) so applying the patch over prior state clears stale
 * flags — switching from "Projects" to "Sent" must not leave `hideCompleted`
 * behind. Spread it as `setState((prev) => ({ ...prev, ...progressToFlags(p) }))`.
 */
export function progressToFlags(progress: ProgressFilter): ProgressFlagsPatch {
  const cleared: ProgressFlagsPatch = {
    hideAttempted: undefined,
    hideCompleted: undefined,
    showOnlyAttempted: undefined,
    showOnlyCompleted: undefined,
  };
  switch (progress) {
    case 'all':
      return cleared;
    case 'untried':
      return { ...cleared, hideAttempted: true, hideCompleted: true };
    case 'projects':
      return { ...cleared, showOnlyAttempted: true, hideCompleted: true };
    case 'sent':
      return { ...cleared, showOnlyCompleted: true };
    case 'unsent':
      return { ...cleared, hideCompleted: true };
  }
}

/**
 * Reads the current progress choice back out of the flags, for a control that
 * needs to show its selected value. Precedence is deliberate and total so every
 * flag combination — including legacy ones from the old independent switches —
 * resolves to exactly one value:
 *
 * 1. `showOnlyCompleted`  → `sent`
 * 2. `showOnlyAttempted`  → `projects` (with or without `hideCompleted`; the old
 *    stand-alone "Only attempted" switch resolves here, its closest lens)
 * 3. `hideAttempted` + `hideCompleted` → `untried`
 * 4. `hideCompleted`      → `unsent`
 *
 * A lone `hideAttempted` (an old switch state with no dedicated lens — "hide
 * climbs I've attempted", i.e. show untried + sent) has no bucket and resolves
 * to `all`; it self-heals the moment the user picks any value, since
 * {@link progressToFlags} writes a full patch. Only pre-existing stored searches
 * can carry it, and this selector is the only writer going forward.
 */
export function flagsToProgress(flags: ProgressFlags): ProgressFilter {
  if (flags.showOnlyCompleted) return 'sent';
  if (flags.showOnlyAttempted) return 'projects';
  if (flags.hideAttempted && flags.hideCompleted) return 'untried';
  if (flags.hideCompleted) return 'unsent';
  return 'all';
}

/** True when any progress lens is active (i.e. the selector is not on "All"). */
export function isProgressFilterActive(flags: ProgressFlags): boolean {
  return flagsToProgress(flags) !== 'all';
}
