import { memo, useCallback, useMemo, useState, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { InsetGroupedList, insetGroupedRowStyles } from '../InsetGroupedList';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import type { BoardCardMenuAction, BoardCardMenuCapabilities, BoardCardMenuVia } from './board-card-menu';
import type { BoardCardMenu, DiscoveryBoardItem } from './BoardDiscoveryCardView';
import { BoardRow } from './BoardRow';
import type { DiscoveryBoardArtProps } from './DiscoveryBoardArt';
import { collapsedRows } from './picker-top-view';
import { useBoardCardMenuLabels } from './use-board-card-menu-labels';

export type BoardRowListProps = {
  items: readonly DiscoveryBoardItem[];
  /** A tap on a row, with its 0-based place in the list as drawn. */
  onSelect: (item: DiscoveryBoardItem, position: number) => void;
  /**
   * What each row's menu may offer (the ⋯, the hold). Absent draws plain rows.
   * Memoize it: a new object re-renders every row.
   */
  menuCapabilities?: BoardCardMenuCapabilities;
  /** Runs a picked menu row, with the row's place as drawn. Only read alongside `menuCapabilities`. Memoize it. */
  onMenuAction?: (
    item: DiscoveryBoardItem,
    action: BoardCardMenuAction,
    via: BoardCardMenuVia,
    position: number,
  ) => void;
  /**
   * The rows that get the menu, by item key; absent, all of them. At {gym}
   * lists the whole roster, and only the climber's own and followed boards
   * have anything to pin, download or manage.
   */
  menuKeys?: ReadonlySet<string>;
  /**
   * Show this many rows until the climber asks for the rest, always with the
   * selected row and `alwaysShownKeys` among them. The picker's ScrollView
   * cannot host a virtualised list. Absent: every row.
   */
  collapsedRowCount?: number;
  /** Rows a collapsed list keeps in view besides the selected one: the walls the scan heard. */
  alwaysShownKeys?: ReadonlySet<string>;
  BoardArt: ComponentType<DiscoveryBoardArtProps>;
  testID?: string;
};

/**
 * Boards as an inset-grouped list of `BoardRow`s, with one menu object for the
 * whole list, so a row re-renders only when its own item, or its place, changes.
 */
export const BoardRowList = memo(function BoardRowList({
  items,
  onSelect,
  menuCapabilities,
  onMenuAction,
  menuKeys,
  collapsedRowCount,
  alwaysShownKeys,
  BoardArt,
  testID,
}: BoardRowListProps) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const menuLabels = useBoardCardMenuLabels();
  const [expanded, setExpanded] = useState(false);
  const expand = useCallback(() => setExpanded(true), []);
  const shownItems = useMemo(
    () =>
      collapsedRowCount === undefined || expanded
        ? items
        : collapsedRows(
            items,
            (item) => item.isActive === true || (alwaysShownKeys?.has(item.key) ?? false),
            collapsedRowCount,
          ),
    [items, collapsedRowCount, expanded, alwaysShownKeys],
  );
  // Each row's place as drawn, which is what a pick reports.
  const positions = useMemo(() => new Map(shownItems.map((item, index) => [item.key, index])), [shownItems]);
  const select = useCallback(
    (item: DiscoveryBoardItem) => onSelect(item, positions.get(item.key) ?? 0),
    [onSelect, positions],
  );
  const runMenuAction = useCallback(
    (item: DiscoveryBoardItem, action: BoardCardMenuAction, via: BoardCardMenuVia) =>
      onMenuAction?.(item, action, via, positions.get(item.key) ?? 0),
    [onMenuAction, positions],
  );
  const menu = useMemo<BoardCardMenu | undefined>(
    () =>
      menuCapabilities && onMenuAction
        ? { capabilities: menuCapabilities, labels: menuLabels, onAction: runMenuAction }
        : undefined,
    [menuCapabilities, onMenuAction, menuLabels, runMenuAction],
  );
  return (
    <View style={styles.gutter}>
      <InsetGroupedList testID={testID}>
        {shownItems.map((item) => (
          <BoardRow
            key={item.key}
            item={item}
            onPress={select}
            menu={menuKeys === undefined || menuKeys.has(item.key) ? menu : undefined}
            BoardArt={BoardArt}
          />
        ))}
        {shownItems.length < items.length ? (
          <PressableSurface
            key="show-all"
            onPress={expand}
            feedback="opacity"
            rippleColor={systemColors.label as string}
            accessibilityRole="button"
            style={insetGroupedRowStyles.row}
          >
            {/* Lined up with the titles above it. */}
            <View style={insetGroupedRowStyles.leading} />
            <Text variant="body" color={systemColors.accent} style={insetGroupedRowStyles.text}>
              {t('mobile.inRange.showAll', { count: items.length })}
            </Text>
          </PressableSurface>
        ) : null}
      </InsetGroupedList>
    </View>
  );
});

const styles = StyleSheet.create({
  gutter: {
    paddingHorizontal: spacing[4],
  },
});
