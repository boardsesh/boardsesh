/**
 * The "don't silently bin the climber's stroke" rule, separated from the dialog
 * that asks about it.
 *
 * This is the fix a review of #4859 asked for: selecting another hold, switching
 * kind, stepping to the next placement and deselecting all used to drop a
 * validated draft outright, so a finished stroke vanished on a stray tap with
 * nothing said. Next/Prev made that worse, because a mass-correction pass is
 * exactly where losing a stroke costs real work.
 *
 * The rule lives here as a pure function rather than inline in the screen so it
 * can be tested without rendering a board or stubbing `Alert`. The screen
 * supplies the asking; this decides whether to ask.
 */

/**
 * Shows the confirmation, invoking `onConfirm` only if the user agrees.
 * Deliberately returns nothing: the answer arrives through the callback, on the
 * platform's own schedule.
 */
export type DraftDiscardConfirm = (onConfirm: () => void) => void;

/**
 * Run `action`, first confirming when it would discard unsaved work.
 *
 * With no draft in flight this is a straight call — the common case, and it must
 * stay synchronous so ordinary navigation never feels gated. With a draft, the
 * ONLY path to `action` is through `confirm`; this function never runs it
 * itself, which is the property the tests pin.
 */
export function withUnsavedDraftGuard(
  hasUnsavedDraft: boolean,
  action: () => void,
  confirm: DraftDiscardConfirm,
): void {
  if (!hasUnsavedDraft) {
    action();
    return;
  }
  confirm(action);
}
