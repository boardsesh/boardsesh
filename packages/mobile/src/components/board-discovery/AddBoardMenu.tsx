import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { BoardKind, BoardPickerAddKind } from '../../lib/boards/board-picker-add-analytics';
import { useTheme } from '../../providers/theme-provider';
import { topBarFor } from '../../theme/top-bar';
import { AppMenu, type AppMenuAction } from '../AppMenu';

/** The menu's rows, in order. `onSelectIndex` indexes into this. */
export const ADD_BOARD_MENU_KINDS: readonly BoardPickerAddKind[] = ['board', 'spraywall', 'gym_map'];

/** One row of the gym-first menu: the way to add, and for the builder, whose board it is. */
export type AddBoardMenuRow = { kind: BoardPickerAddKind; boardKind?: BoardKind };

/**
 * The gym-first menu's rows (#8151, `create-board-gym-first`): "Set up a board"
 * splits into the climber's own board and a board at their gym, so a gym wall
 * someone already added is found before it is added again.
 */
export const GYM_FIRST_ADD_BOARD_MENU_ROWS: readonly AddBoardMenuRow[] = [
  { kind: 'board', boardKind: 'home' },
  { kind: 'board', boardKind: 'gym' },
  { kind: 'spraywall' },
  { kind: 'gym_map' },
];

const CLASSIC_ADD_BOARD_MENU_ROWS: readonly AddBoardMenuRow[] = ADD_BOARD_MENU_KINDS.map((kind) => ({ kind }));

/**
 * The + in the board picker's and Manage boards' top bar: Set up a board (the
 * builder), Add a Spraywall (the add-a-wall wizard), then, after a divider,
 * Find a gym (the gym map). One menu for both screens, so the ways to add
 * a board read the same wherever the climber meets them.
 *
 * Set as the screen's `headerRight`. On Liquid Glass UIKit draws its glass around
 * the bar view, so the glyph keeps the native bar's frame (the leading X's
 * size) and draws no fill of its own; Material draws the M3 `add` IconButton.
 * The caller only offers it online and signed in.
 */
export function AddBoardMenu({
  onSelect,
  gymFirst = false,
}: {
  onSelect: (kind: BoardPickerAddKind, boardKind?: BoardKind) => void;
  /** Split "Set up a board" into "My own board" and "A board at my gym" (#8151). */
  gymFirst?: boolean;
}) {
  const { t } = useTranslation('boards');
  const { variant } = useTheme();
  const anchorSize = topBarFor(variant).nativeBarGlyphFrame;
  const rows = gymFirst ? GYM_FIRST_ADD_BOARD_MENU_ROWS : CLASSIC_ADD_BOARD_MENU_ROWS;
  const actions = useMemo<AppMenuAction[]>(() => {
    const boardRows: AppMenuAction[] = gymFirst
      ? [
          { label: t('mobile.addBoard.ownBoard'), systemIcon: 'house' },
          { label: t('mobile.addBoard.gymBoard'), systemIcon: 'building.2' },
        ]
      : [{ label: t('mobile.addBoard.setUp'), systemIcon: 'square.grid.3x3' }];
    return [
      ...boardRows,
      { label: t('mobile.addBoard.sprayWall'), systemIcon: 'camera' },
      { label: t('mobile.addBoard.findGym'), systemIcon: 'map', dividerBefore: true },
    ];
  }, [t, gymFirst]);
  const handleSelect = useCallback(
    (index: number) => {
      const row = rows[index];
      if (!row) return;
      if (row.boardKind) onSelect(row.kind, row.boardKind);
      else onSelect(row.kind);
    },
    [onSelect, rows],
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
