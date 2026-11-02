/**
 * Whether the climb on screen is lit on the wall, for the wall button's "Lit on
 * the wall" (#6939, #7000). The board image draws the same glowing holds either
 * way, so without it a first-timer can't tell a lit climb from a preview.
 *
 * Pure like `wall-state.ts`: the ladder is table-tested here rather than by
 * rendering PlayCore. Darkness (the #4979 hold, lights turned off) is known
 * only on the phone holding the link; a crew phone reads presence alone.
 */

/**
 * - `lit` — the climb on screen is the one lit on the board.
 * - `notLit` — anything else: a preview while the wall shows another climb, a
 *   climb only this climber sees in a crew, no live link, or the board kept the
 *   current climb dark. The wall button says Put on board.
 */
export type WallLitState = 'lit' | 'notLit';

export type WallLitInput = {
  isAnonymous: boolean;
  /** A board with lights is selected. False for spray walls and boards flagged ledless. */
  boardHasLights: boolean;
  /** The switch-board overlay covers the board: it says what's wrong itself. */
  boardMismatch: boolean;
  /**
   * The climb belongs to another board the climber can reach, so no overlay
   * covers it, but the connected wall refuses to light its holds.
   */
  otherBoard: boolean;
  displayedClimbUuid: string | null;
  /** The climber's own committed climb (the queue head), if any. */
  committedHeadUuid: string | null;
  /** The climb physically lit on the board, if any. */
  wallClimbUuid: string | null;
  /** A preview is pinned. */
  isPreview: boolean;
  /** A wall is genuinely being driven — see `WallPillStateInput.wallDriven`. */
  wallDriven: boolean;
  /**
   * The link is up but the current climb is dark: the #4979 hold kept it off,
   * or its lights were turned off. The presence feed can still name it.
   */
  currentDark: boolean;
  /**
   * The climb the board-presence feed says was turned off and not lit since
   * (#7015): the crewmate driving the wall used Turn off all lights. `null` when
   * no clear was seen, and while this phone holds the link (its own store is
   * `currentDark`). Keyed on the climb, never "the wall is dark", so a queue
   * that moved ahead of the presence echo isn't called dark.
   */
  presenceClearedClimbUuid?: string | null;
  /**
   * Presence's wall climb was lit under an hour ago (QA #147,
   * `isPresenceFresh`). With no live link it is trusted that long: Aurora and
   * MoonBoard boxes keep their LEDs after a disconnect.
   */
  presenceFresh?: boolean;
};

/**
 * First match wins. `null` means there is nothing to say: the signed-out
 * reader, a wall with no lights, the switch-board overlay, or no climb.
 */
export function resolveWallLit({
  isAnonymous,
  boardHasLights,
  boardMismatch,
  otherBoard,
  displayedClimbUuid,
  committedHeadUuid,
  wallClimbUuid,
  isPreview,
  wallDriven,
  currentDark,
  presenceClearedClimbUuid = null,
  presenceFresh = false,
}: WallLitInput): WallLitState | null {
  if (isAnonymous || !boardHasLights || boardMismatch || displayedClimbUuid === null) return null;
  if (otherBoard) return 'notLit';
  // No live link (this phone's or a crewmate's): trust presence for an hour
  // (QA #147), never past it. The feed can still name a climb lit hours ago.
  if (!wallDriven) {
    const onWallPerPresence =
      presenceFresh && displayedClimbUuid === wallClimbUuid && displayedClimbUuid !== presenceClearedClimbUuid;
    return onWallPerPresence ? 'lit' : 'notLit';
  }
  if (currentDark && displayedClimbUuid === committedHeadUuid) return 'notLit';
  // A crewmate's phone turned the lights off on this climb. Checked before the
  // driven-wall fall-through below, which would otherwise call it lit.
  if (displayedClimbUuid === presenceClearedClimbUuid && displayedClimbUuid === committedHeadUuid) return 'notLit';
  if (displayedClimbUuid === wallClimbUuid) return 'lit';
  if (isPreview && displayedClimbUuid !== committedHeadUuid) return 'notLit';
  // The climber's own current climb on a driven wall: the link lights whatever
  // is current. The board-presence echo that names the lit climb comes from the
  // server and can lag a swipe or never come at all offline, so waiting for it
  // would flash "Not lit" on every step, or claim it over a lit board.
  return 'lit';
}
