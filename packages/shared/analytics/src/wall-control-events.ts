/**
 * Why the climb on the player's screen is a preview (2.7, preview-first), sent
 * as `previewReason` on Wall Control Shown and Wall Control Tapped while the
 * climb on screen is one. Read with the two events' `state` to tell the
 * default preview of a tap from the private look a crew gets, and from a climb
 * the wall can't light.
 *
 * - `default`: a solo preview, the way every tap opens a climb since 2.7 unless
 *   this phone drives the wall (Always drive the wall included; Light the board
 *   when I tap a climb before 2026-11).
 * - `session`: a browse in a party session (or its latch after the crew left),
 *   so a look never takes the crew's wall.
 * - `other_board`: the climb belongs to another board, which the connected wall
 *   can't light. Outranks the other two.
 */
export type WallControlPreviewReason = 'default' | 'session' | 'other_board';

export type WallControlPreviewReasonInput = {
  /** A preview is pinned over the committed climb. */
  isPreview: boolean;
  /** The climb on screen is on another board than the one the climber is on. */
  otherBoard: boolean;
  /** A crew is here, or the browse latch armed while one was. */
  inSession: boolean;
};

/** `previewReason` for the climb on screen, or `null` when it is not a preview. */
export function wallControlPreviewReason({
  isPreview,
  otherBoard,
  inSession,
}: WallControlPreviewReasonInput): WallControlPreviewReason | null {
  if (!isPreview) return null;
  if (otherBoard) return 'other_board';
  return inSession ? 'session' : 'default';
}
