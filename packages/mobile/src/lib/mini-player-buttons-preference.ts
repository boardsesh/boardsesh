import { createSectionLayoutStore, settingsLayoutStorage, useSectionLayout } from './section-layout-store';
import { MINI_PLAYER_BUTTONS_LAYOUT, type MiniPlayerButtonsLayout } from './mini-player-buttons';

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
