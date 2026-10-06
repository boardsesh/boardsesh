// Whether an Apple Pencil has been used in the spray editor this session, and
// what that means for fingers.
//
// The Pencil itself needs no mode: on the iPad layout every touch is checked for
// a stylus, and a Pencil always marks. "Pencil only" is about FINGERS. With it
// on, a finger only picks rings and moves around the wall, so a palm or a thumb
// can never switch or add a hold by accident. It turns itself on the first time
// a Pencil touches or hovers over the wall, because that is the moment the
// climber has shown they have one.
//
// The "seen" flag is module-scoped rather than component state: the add-a-wall
// wizard remounts the editor between steps, and a climber who has already used
// the Pencil should not have to show it again to get Pencil only back. It lasts
// until the app is killed. The climber's own choice from the rail outlives that:
// it is saved per device (`SPRAY_PENCIL_ONLY_KEY`) and wins over the automatic
// answer.

import type { HoldGeometry } from './spray-hold-tools';

export const SPRAY_PENCIL_ONLY_KEY = 'boardsesh_spray_editor_pencil_only';

let pencilSeen = false;
const listeners = new Set<() => void>();

/** For `useSyncExternalStore`. */
export function subscribePencilSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function pencilSeenThisSession(): boolean {
  return pencilSeen;
}

/** A Pencil touched or hovered over the wall. True only the first time, so the caller can react once. */
export function markPencilSeen(): boolean {
  if (pencilSeen) return false;
  pencilSeen = true;
  for (const listener of listeners) listener();
  return true;
}

/** Tests only: forget the Pencil, as a fresh launch would. */
export function resetPencilSessionForTests(): void {
  pencilSeen = false;
  for (const listener of listeners) listener();
}

/** A stored override read back: the climber's own choice, or null for "never chose". */
export function parsePencilOnlyOverride(stored: unknown): boolean | null {
  return typeof stored === 'boolean' ? stored : null;
}

/**
 * Whether fingers are in "Pencil only" mode. The climber's saved choice wins;
 * without one it follows whether a Pencil has been seen. Never on outside the
 * iPad layout, where the phone rules apply to every touch.
 */
export function resolvePencilOnly({
  tablet,
  pencilSeen: seen,
  override,
}: {
  tablet: boolean;
  pencilSeen: boolean;
  override: boolean | null;
}): boolean {
  if (!tablet) return false;
  return override ?? seen;
}

/**
 * The rail's Pencil only toggle appears once it means something: a Pencil has
 * been seen, or the climber chose on an earlier visit.
 */
export function pencilToggleAvailable({
  tablet,
  pencilSeen: seen,
  override,
}: {
  tablet: boolean;
  pencilSeen: boolean;
  override: boolean | null;
}): boolean {
  return tablet && (seen || override != null);
}

/**
 * What a Pencil stroke on the resting editor does, once it is long enough not
 * to be a tap. A stroke whose centre lands inside the selected hold redraws that
 * hold's outline; anything else is a new hold. Where the stroke STARTED does not
 * matter here: one that starts on the selected ring never reaches this, because
 * it is a move and the drag takes it at touch-down.
 *
 * Any role is retraced, not only an 'on' hold: the reducer stamps the new
 * outline accepted, so circling a selected ghost or maybe switches it on, the
 * same as a Pencil tap on it would. Adding a second hold on top of it instead
 * would leave a duplicate under the climber's outline.
 */
export function pencilStrokeTarget(
  stroke: Pick<HoldGeometry, 'cx' | 'cy'>,
  selected: (Pick<HoldGeometry, 'cx' | 'cy' | 'r'> & { id: number }) | null,
): { kind: 'retrace'; id: number } | { kind: 'add' } {
  if (selected && Math.hypot(stroke.cx - selected.cx, stroke.cy - selected.cy) <= selected.r) {
    return { kind: 'retrace', id: selected.id };
  }
  return { kind: 'add' };
}
