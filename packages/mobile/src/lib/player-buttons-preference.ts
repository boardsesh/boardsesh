import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { getSetting, setSetting, subscribeSettings, useSetting } from '../settings/hooks';
import {
  isSameSectionLayout,
  sanitiseSectionLayout,
  type SectionLayoutRecord,
  type SectionMoveDirection,
} from './section-layout';
import { createSectionLayoutStore, useSectionLayout } from './section-layout-store';
import {
  DEFAULT_PLAYER_BOARD_CONTROL,
  DEFAULT_PLAYER_BUTTONS,
  DEFAULT_PLAYER_BUTTONS_POSITION,
  DEFAULT_PLAYER_PREVIOUS_NEXT,
  PLAYER_BUTTONS_LAYOUT,
  sanitisePlayerBoardControl,
  sanitisePlayerButtonsPosition,
  sanitisePlayerPreviousNext,
  type PlayerBoardControl,
  type PlayerButtonId,
  type PlayerButtonsLayout,
  type PlayerButtonsPosition,
} from './player-buttons';

// The climber's player buttons, kept in the synchronous settings store (MMKV),
// so the bar is drawn right on its first frame: no jump from today's bar to
// theirs. Device-local, like the sections below the climb.
//
// Three keys: the buttons' order and switches (`playerButtonsV2`, `null` while
// they match the defaults, so a later release's defaults still reach a climber
// who never changed them), the Previous and next switch, and the position.
// `resetAllSettings` clears all three. #7000 moved the buttons to a new key:
// they now fill the first row's two end slots, so a `playerButtonsV1` record
// (round 2's two rows) would mean something else, and nothing reads it. The
// round-2 `playerWallBadge` switch went too.

/** The stored choice. A record the section store would ignore (another version, not a record) reads as the default. */
function readBoardControl(): PlayerBoardControl {
  try {
    const record: unknown = getSetting('playerButtonsV2');
    if (typeof record !== 'object' || record === null || !('version' in record) || record.version !== 1) {
      return DEFAULT_PLAYER_BOARD_CONTROL;
    }
    return sanitisePlayerBoardControl('boardControl' in record ? record.boardControl : undefined);
  } catch {
    return DEFAULT_PLAYER_BOARD_CONTROL;
  }
}

// The board control rides the buttons' record (#7000). The section store only
// knows order and switches, so its writes carry the choice across: a layout
// back on its defaults stays a record while the bulb is chosen.
export const playerButtonsStore = createSectionLayoutStore({
  spec: PLAYER_BUTTONS_LAYOUT,
  read: () => getSetting('playerButtonsV2'),
  write: (record) => setSetting('playerButtonsV2', withBoardControl(record, readBoardControl())),
});

function withBoardControl(
  record: SectionLayoutRecord | null,
  boardControl: PlayerBoardControl,
): (SectionLayoutRecord & { boardControl?: string }) | null {
  if (boardControl === DEFAULT_PLAYER_BOARD_CONTROL) {
    if (record === null) return null;
    const { order, visible } = record;
    return { version: 1, order, visible };
  }
  const base = record ?? {
    version: 1 as const,
    order: [...DEFAULT_PLAYER_BUTTONS.order],
    visible: { ...DEFAULT_PLAYER_BUTTONS.visible },
  };
  return { version: 1, order: base.order, visible: base.visible, boardControl };
}

/** Choose the wall button or the bulb, keeping the buttons' order and switches. */
export function setPlayerBoardControl(boardControl: PlayerBoardControl): void {
  if (readBoardControl() === boardControl) return;
  let stored: SectionLayoutRecord | null = null;
  try {
    const current = getSetting('playerButtonsV2');
    if (current && current.version === 1) stored = current;
  } catch {
    // An unreadable record reads as the defaults.
  }
  // Back on the wall button with the buttons on their defaults: `null` again,
  // so a later release's defaults still reach this climber.
  if (
    boardControl === DEFAULT_PLAYER_BOARD_CONTROL &&
    stored !== null &&
    isSameSectionLayout(sanitiseSectionLayout(PLAYER_BUTTONS_LAYOUT, stored), DEFAULT_PLAYER_BUTTONS) &&
    stored.order.length === DEFAULT_PLAYER_BUTTONS.order.length
  ) {
    stored = null;
  }
  setSetting('playerButtonsV2', withBoardControl(stored, boardControl));
}

function subscribeBoardControl(listener: () => void): () => void {
  return subscribeSettings(listener);
}

/** The wall button or the bulb. A primitive snapshot, so unrelated writes don't re-render. */
export function usePlayerBoardControl(): PlayerBoardControl {
  return useSyncExternalStore(subscribeBoardControl, readBoardControl, readBoardControl);
}

export type PlayerButtonsPreference = {
  buttons: PlayerButtonsLayout;
  previousNext: boolean;
  position: PlayerButtonsPosition;
  boardControl: PlayerBoardControl;
};

export function isDefaultPlayerButtons({
  buttons,
  previousNext,
  position,
  boardControl,
}: PlayerButtonsPreference): boolean {
  return (
    isSameSectionLayout(buttons, DEFAULT_PLAYER_BUTTONS) &&
    previousNext === DEFAULT_PLAYER_PREVIOUS_NEXT &&
    position === DEFAULT_PLAYER_BUTTONS_POSITION &&
    boardControl === DEFAULT_PLAYER_BOARD_CONTROL
  );
}

/** Restore defaults: today's bar, below the board, with Previous and next and the wall button. */
export function restorePlayerButtonDefaults(): void {
  setPlayerBoardControl(DEFAULT_PLAYER_BOARD_CONTROL);
  playerButtonsStore.restoreDefaults();
  // Written only when they differ, so a restore doesn't wake every settings reader twice.
  if (sanitisePlayerPreviousNext(getSetting('playerPreviousNext')) !== DEFAULT_PLAYER_PREVIOUS_NEXT) {
    setSetting('playerPreviousNext', DEFAULT_PLAYER_PREVIOUS_NEXT);
  }
  if (sanitisePlayerButtonsPosition(getSetting('playerButtonsPosition')) !== DEFAULT_PLAYER_BUTTONS_POSITION) {
    setSetting('playerButtonsPosition', DEFAULT_PLAYER_BUTTONS_POSITION);
  }
}

/** What the player draws from. Re-renders only when one of the four changes. */
export function usePlayerButtonsPreference(): PlayerButtonsPreference {
  const buttons = useSectionLayout(playerButtonsStore);
  const boardControl = usePlayerBoardControl();
  const [storedPreviousNext] = useSetting('playerPreviousNext');
  const [storedPosition] = useSetting('playerButtonsPosition');
  const previousNext = sanitisePlayerPreviousNext(storedPreviousNext);
  const position = sanitisePlayerButtonsPosition(storedPosition);
  return useMemo(
    () => ({ buttons, previousNext, position, boardControl }),
    [buttons, previousNext, position, boardControl],
  );
}

/** The preference plus every way to change it, for View options and Settings. */
export function usePlayerButtonsEditor() {
  const preference = usePlayerButtonsPreference();
  const [, writePreviousNext] = useSetting('playerPreviousNext');
  const [, writePosition] = useSetting('playerButtonsPosition');
  const setVisible = useCallback(
    (buttonId: PlayerButtonId, visible: boolean) => playerButtonsStore.setVisible(buttonId, visible),
    [],
  );
  const move = useCallback(
    (buttonId: PlayerButtonId, direction: SectionMoveDirection) => playerButtonsStore.move(buttonId, direction),
    [],
  );
  return {
    ...preference,
    setVisible,
    move,
    setPreviousNext: writePreviousNext,
    setPosition: writePosition,
    setBoardControl: setPlayerBoardControl,
    restoreDefaults: restorePlayerButtonDefaults,
  };
}
