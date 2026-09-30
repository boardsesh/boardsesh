import type { HoldGeometry } from './spray-hold-tools';
import type { SprayEditorHold } from './spray-hold-editor-reducer';

/**
 * What the single spotlight is marking. `toggle` and `add` follow a tap, `undo`
 * rings the hold an undo just put back.
 */
export type SpraySpotlightKind = 'toggle' | 'add' | 'undo';

/**
 * One spotlight moment. `key` changes every time, so the same hold tapped twice
 * in a row still plays twice.
 */
export type SpraySpotlightPulse = {
  key: number;
  kind: SpraySpotlightKind;
  hold: HoldGeometry;
};

/**
 * The hold an undo changed, for the spotlight to ring.
 *
 * Compares the holds before and after the undo by identity: the reducer only
 * replaces the holds an action touched, so every other entry is the same object
 * on both sides. When a hold came back it is drawn where it came back to; when
 * the undo took one away (an undone add) it is drawn where it was, so the
 * climber still sees what changed. An undo that touched several (a join) rings
 * the first by id. Null when nothing changed.
 */
export function revertedHold(
  before: Readonly<Record<number, SprayEditorHold>>,
  after: Readonly<Record<number, SprayEditorHold>>,
): HoldGeometry | null {
  let changedId: number | null = null;
  const consider = (id: number) => {
    if (before[id] === after[id]) return;
    if (changedId == null || id < changedId) changedId = id;
  };
  for (const key of Object.keys(after)) consider(Number(key));
  for (const key of Object.keys(before)) if (!(key in after)) consider(Number(key));
  if (changedId == null) return null;
  const hold = after[changedId] ?? before[changedId];
  return hold ? { cx: hold.cx, cy: hold.cy, r: hold.r, outline: hold.outline } : null;
}
