import { useCallback, useMemo } from 'react';
import { getSetting, setSetting, useSetting } from '../settings/hooks';
import { isSameSectionLayout, type SectionMoveDirection } from './section-layout';
import { createSectionLayoutStore, useSectionLayout } from './section-layout-store';
import {
  DEFAULT_PLAYER_BUTTONS,
  DEFAULT_PLAYER_BUTTONS_POSITION,
  DEFAULT_PLAYER_PREVIOUS_NEXT,
  PLAYER_BUTTONS_LAYOUT,
  sanitisePlayerButtonsPosition,
  sanitisePlayerPreviousNext,
  type PlayerButtonId,
  type PlayerButtonsLayout,
  type PlayerButtonsPosition,
} from './player-buttons';

// The climber's player buttons, kept in the synchronous settings store (MMKV),
// so the bar is drawn right on its first frame: no jump from today's bar to
// theirs. Device-local, like the sections below the climb.
//
// Three keys: the buttons' order and switches (`playerButtonsV1`, `null` while
// they match the defaults, so a later release's defaults still reach a climber
// who never changed them), the Previous and next switch, and the position.
// `resetAllSettings` clears all three.

export const playerButtonsStore = createSectionLayoutStore({
  spec: PLAYER_BUTTONS_LAYOUT,
  read: () => getSetting('playerButtonsV1'),
  write: (record) => setSetting('playerButtonsV1', record),
});

export type PlayerButtonsPreference = {
  buttons: PlayerButtonsLayout;
  previousNext: boolean;
  position: PlayerButtonsPosition;
};

export function isDefaultPlayerButtons({ buttons, previousNext, position }: PlayerButtonsPreference): boolean {
  return (
    isSameSectionLayout(buttons, DEFAULT_PLAYER_BUTTONS) &&
    previousNext === DEFAULT_PLAYER_PREVIOUS_NEXT &&
    position === DEFAULT_PLAYER_BUTTONS_POSITION
  );
}

/** Restore defaults: today's bar, below the board, with Previous and next. */
export function restorePlayerButtonDefaults(): void {
  playerButtonsStore.restoreDefaults();
  // Written only when they differ, so a restore doesn't wake every settings reader twice.
  if (sanitisePlayerPreviousNext(getSetting('playerPreviousNext')) !== DEFAULT_PLAYER_PREVIOUS_NEXT) {
    setSetting('playerPreviousNext', DEFAULT_PLAYER_PREVIOUS_NEXT);
  }
  if (sanitisePlayerButtonsPosition(getSetting('playerButtonsPosition')) !== DEFAULT_PLAYER_BUTTONS_POSITION) {
    setSetting('playerButtonsPosition', DEFAULT_PLAYER_BUTTONS_POSITION);
  }
}

/** What the player draws from. Re-renders only when one of the three changes. */
export function usePlayerButtonsPreference(): PlayerButtonsPreference {
  const buttons = useSectionLayout(playerButtonsStore);
  const [storedPreviousNext] = useSetting('playerPreviousNext');
  const [storedPosition] = useSetting('playerButtonsPosition');
  const previousNext = sanitisePlayerPreviousNext(storedPreviousNext);
  const position = sanitisePlayerButtonsPosition(storedPosition);
  return useMemo(() => ({ buttons, previousNext, position }), [buttons, previousNext, position]);
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
    restoreDefaults: restorePlayerButtonDefaults,
  };
}
