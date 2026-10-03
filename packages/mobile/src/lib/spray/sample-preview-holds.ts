// Which of a new wall's holds the look step lights up.
//
// The look step previews the climber's OWN wall, before it has a single climb on
// it — so there is no real climb to draw, and the preview is a stand-in made of
// the wall's own holds. Pure, so the choice is the same on every render and
// every device, and testable without a renderer.

import type { HoldState } from '@boardsesh/shared-schema';

/**
 * How many holds the preview lights.
 *
 * A real problem's worth: enough that every role colour shows and the look's
 * glow has neighbours to merge with, few enough that the unlit wall — which the
 * veil and the outline treat differently in every look — is still most of the
 * picture.
 */
export const DEFAULT_SPRAY_WALL_PREVIEW_HOLD_COUNT = 12;

/**
 * An evenly spaced sample of `targetCount` hold ids.
 *
 * Not the first N (on a wall detected tile by tile those cluster in one corner)
 * and not random (the cards would light a different set on every mount, and a
 * cached overlay would never be reused). The ids are sorted ascending and
 * de-duplicated first, then one id is taken from the middle of each of
 * `targetCount` equal slices of the list. A wall with fewer holds than asked
 * for lights all of them.
 */
export function samplePreviewHolds(holdIds: readonly number[], targetCount: number): number[] {
  const sorted = [...new Set(holdIds)].sort((left, right) => left - right);
  const count = Math.min(sorted.length, Math.max(0, Math.floor(targetCount)));
  if (count === 0) return [];
  if (count === sorted.length) return sorted;

  // Each slice is at least one id wide (count < length), so the midpoints are
  // strictly increasing and no id is taken twice.
  const sliceWidth = sorted.length / count;
  const sampled: number[] = [];
  for (let slice = 0; slice < count; slice += 1) {
    sampled.push(sorted[Math.floor((slice + 0.5) * sliceWidth)]);
  }
  return sampled;
}

/**
 * The role each lit hold plays, bottom of the wall to top.
 *
 * A preview that lit every hold the same colour would hide half of what a look
 * changes — the role colours, the finish, the feet — so the stand-in climb
 * reads like a real one: feet lowest, then the start holds, hands up the
 * middle, one finish at the top. Small walls drop the extras first, feet
 * before a second start.
 */
export function previewRolesBottomToTop(count: number): HoldState[] {
  if (count <= 0) return [];
  if (count === 1) return ['HAND'];

  const feet = count >= 8 ? 2 : count >= 4 ? 1 : 0;
  const starts = count >= 6 ? 2 : 1;
  const hands = count - feet - starts - 1;

  return [
    ...Array<HoldState>(feet).fill('FOOT'),
    ...Array<HoldState>(starts).fill('STARTING'),
    ...Array<HoldState>(hands).fill('HAND'),
    'FINISH',
  ];
}
