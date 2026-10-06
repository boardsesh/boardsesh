/**
 * What one finger tap on the spray hold editor means, as a pure function.
 *
 * The rule the climber learns is short: a tap PICKS a ring, and a tap on the
 * ring already picked switches it. Nothing a single tap does can change the
 * wall by itself — a stray tap selects, and the selection is just the cursor —
 * so a hold only goes OFF after two taps on the same ring (a double tap reads
 * as select + toggle, with no added wait). Even then it stays on the photo as
 * a ghost until the climber Deletes it.
 *
 * Bare wall never adds a hold. With a ring picked, it puts the ring down; with
 * nothing picked, the screen answers with a ripple and a hint pointing at the
 * real way to add one, so a tap that used to add a hold is not met with silence.
 *
 * The screen resolves the hit test (`holdAtPoint`, hidden maybes included) and
 * hands the answer here; its `handleTap` is a switch over the result.
 *
 * On the iPad layout the Apple Pencil has its own, shorter rule: the Pencil
 * marks and fingers inspect. A Pencil tap switches the ring under it outright —
 * no pick first — and a Pencil tap on bare wall adds a hold there. With "Pencil
 * only" on, a finger never changes the wall at all: it picks a ring (which opens
 * the inspector) and puts it down on bare wall. With it off a finger follows the
 * phone rule above. The phone layout never passes `input: 'pencil'`, so none of
 * this reaches it.
 */

/**
 * What the editor is doing with the next touch.
 *
 * `edit` is the resting state: taps pick and switch rings, long presses pick
 * them up. `trace` and `join` are one-shot tools a selected hold starts, each
 * with its own banner and a Cancel — never modes a climber has to remember to
 * leave. `refine` is the selected hold's touch-up brush: it takes as many
 * strokes as the climber wants and ends with Done (one edit) or Cancel (none),
 * and while it is open every one-finger touch paints. `add` is the other
 * exception, and is a mode on purpose: the scan misses holds
 * in handfuls, so it stays on until Done, and while it is on a touch never
 * selects or picks up a ring — which is what makes a missed hold squeezed
 * between two rings reachable at all.
 */
export type SprayEditorTool = 'edit' | 'trace' | 'join' | 'add' | 'refine';

export type SprayEditTapResult =
  /** Pick the ring under the finger. No change to the wall. */
  | 'select'
  /** The picked ring was tapped again: ON goes OFF (a ghost), OFF or maybe goes ON. */
  | 'toggle'
  /** Bare wall with a ring picked: put it down. */
  | 'deselect'
  /** Join was waiting, and this is its second hold. */
  | 'merge'
  /** Bare wall with nothing picked: ripple, and the "how to add" hint. */
  | 'bareWallHint'
  /** A Pencil tap on bare wall: a circle at the median hold size goes there. */
  | 'addHold'
  /** The tap means nothing in this tool. */
  | 'none';

/** What made the tap. `pencil` only ever comes from the iPad layout. */
export type SprayTapInput = 'finger' | 'pencil';

export function resolveEditTap({
  tool,
  hitId,
  selectedId,
  input = 'finger',
  pencilOnly = false,
}: {
  tool: SprayEditorTool;
  /** The ring the tap landed on, or null for bare wall. */
  hitId: number | null;
  selectedId: number | null;
  input?: SprayTapInput;
  /** "Pencil only" is on: fingers pick and never switch. Ignored for a Pencil tap. */
  pencilOnly?: boolean;
}): SprayEditTapResult {
  if (tool === 'join') {
    // Join waits for the second hold and nothing else: bare wall or the
    // selected hold itself leaves it waiting.
    return hitId != null && selectedId != null && hitId !== selectedId ? 'merge' : 'none';
  }
  // Trace, Refine and Add own their touches through their own overlays; a tap that
  // still arrives here (one in flight as the tool changed) does nothing.
  if (tool !== 'edit') return 'none';
  if (input === 'pencil') return hitId == null ? 'addHold' : 'toggle';
  if (pencilOnly) {
    if (hitId == null) return selectedId != null ? 'deselect' : 'none';
    return hitId === selectedId ? 'none' : 'select';
  }
  if (hitId == null) return selectedId != null ? 'deselect' : 'bareWallHint';
  return hitId === selectedId ? 'toggle' : 'select';
}
