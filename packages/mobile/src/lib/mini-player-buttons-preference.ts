import { useCallback } from 'react';
import { isSameSectionLayout, type SectionMoveDirection } from './section-layout';
import { createSectionLayoutStore, settingsLayoutStorage, useSectionLayout } from './section-layout-store';
import {
  DEFAULT_MINI_PLAYER_BUTTONS,
  MINI_PLAYER_BUTTONS_LAYOUT,
  type MiniPlayerButtonId,
  type MiniPlayerButtonsLayout,
} from './mini-player-buttons';

// The climber's MiniPlayer buttons, kept in the synchronous settings store (MMKV)
// so the bar is right on its first frame: UIKit snapshots the platter, and a row
// that redrew from today's buttons to theirs would be caught mid-change.
// Device-local, like the player's buttons. `null` while it matches the defaults,
// so a later release's defaults still reach a climber who never changed them.
// `resetAllSettings` clears it.

export const miniPlayerButtonsStore = createSectionLayoutStore({
  spec: MINI_PLAYER_BUTTONS_LAYOUT,
  ...settingsLayoutStorage('miniPlayerButtonsV1'),
});

/** What the MiniPlayer draws from. Re-renders only when the layout changes. */
export function useMiniPlayerButtons(): MiniPlayerButtonsLayout {
  return useSectionLayout(miniPlayerButtonsStore);
}

/** The buttons plus every way to change them, for View options and Settings › Climb view. */
export function useMiniPlayerButtonsEditor() {
  const buttons = useMiniPlayerButtons();
  const setVisible = useCallback(
    (buttonId: MiniPlayerButtonId, visible: boolean) => miniPlayerButtonsStore.setVisible(buttonId, visible),
    [],
  );
  const move = useCallback(
    (buttonId: MiniPlayerButtonId, direction: SectionMoveDirection) => miniPlayerButtonsStore.move(buttonId, direction),
    [],
  );
  const restoreDefaults = useCallback(() => miniPlayerButtonsStore.restoreDefaults(), []);
  const isDefault = isSameSectionLayout(buttons, DEFAULT_MINI_PLAYER_BUTTONS);
  return { buttons, isDefault, setVisible, move, restoreDefaults };
}
