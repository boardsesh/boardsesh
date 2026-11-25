import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { BoardPickerAddKind } from '../../lib/boards/board-picker-add-analytics';
import { useTheme } from '../../providers/theme-provider';
import { topBarFor } from '../../theme/top-bar';
import { AppMenu, type AppMenuAction } from '../AppMenu';

/** The menu's rows, in order. `onSelectIndex` indexes into this. */
export const ADD_BOARD_MENU_KINDS: readonly BoardPickerAddKind[] = ['board', 'spraywall', 'gym_map'];

/**
 * The + in the board picker's and Manage boards' top bar with the
 * `add-board-wizard` flag off: Set up a board (the builder), Add a Spraywall
 * (the add-a-wall wizard), then, after a divider, Find a gym (the gym map). One
 * menu for both screens, so the ways to add a board read the same wherever the
 * climber meets them. With the flag on, the + is `AddBoardButton`, which opens
 * the wizard.
 *
 * Set as the screen's `headerRight`. On Liquid Glass UIKit draws its glass around
 * the bar view, so the glyph keeps the native bar's frame (the leading X's
 * size) and draws no fill of its own; Material draws the M3 `add` IconButton.
 * The caller only offers it online and signed in.
 */
export function AddBoardMenu({ onSelect }: { onSelect: (kind: BoardPickerAddKind) => void }) {
  const { t } = useTranslation('boards');
  const { variant } = useTheme();
  const anchorSize = topBarFor(variant).nativeBarGlyphFrame;
  const actions = useMemo<AppMenuAction[]>(
    () => [
      { label: t('mobile.addBoard.setUp'), systemIcon: 'square.grid.3x3' },
      { label: t('mobile.addBoard.sprayWall'), systemIcon: 'camera' },
      { label: t('mobile.addBoard.findGym'), systemIcon: 'map', dividerBefore: true },
    ],
    [t],
  );
  const handleSelect = useCallback(
    (index: number) => {
      const kind = ADD_BOARD_MENU_KINDS[index];
      if (kind) onSelect(kind);
    },
    [onSelect],
  );
  return (
    <AppMenu
      iconName="plus"
      iconAppearance="plain"
      anchorSize={anchorSize}
      accessibilityLabel={t('mobile.addBoard.aria')}
      actions={actions}
      onSelectIndex={handleSelect}
    />
  );
}
