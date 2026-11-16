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
import { collapsedAtGymRows } from './picker-top-view';
import { useBoardCardMenuLabels } from './use-board-card-menu-labels';

export type BoardRowListProps = {
  items: readonly DiscoveryBoardItem[];
  onSelect: (item: DiscoveryBoardItem) => void;
  /**
   * What each row's menu may offer (the ⋯, the hold). Absent draws plain rows.
   * Memoize it: a new object re-renders every row.
   */
  menuCapabilities?: BoardCardMenuCapabilities;
  /** Runs a picked menu row. Only read alongside `menuCapabilities`. Memoize it. */
  onMenuAction?: (item: DiscoveryBoardItem, action: BoardCardMenuAction, via: BoardCardMenuVia) => void;
  /**
   * The rows that get the menu, by item key; absent, all of them. At {gym}
   * lists the whole roster, and only the climber's own and followed boards
   * have anything to pin, download or manage.
   */
  menuKeys?: ReadonlySet<string>;
  /**
   * Show the first few rows (always with the selected one) until the climber
   * asks for the rest: At {gym}, where a big gym holds a dozen walls and the
   * picker's ScrollView cannot host a virtualised list.
   */
  collapsible?: boolean;
  BoardArt: ComponentType<DiscoveryBoardArtProps>;
  testID?: string;
};

function isSelectedItem(item: DiscoveryBoardItem): boolean {
  return item.isActive === true;
}

/**
 * Boards as an inset-grouped list of `BoardRow`s, with one menu object for the
 * whole list, so a row re-renders only when its own item changes.
 */
export const BoardRowList = memo(function BoardRowList({
  items,
  onSelect,
  menuCapabilities,
  onMenuAction,
  menuKeys,
  collapsible = false,
  BoardArt,
  testID,
}: BoardRowListProps) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const menuLabels = useBoardCardMenuLabels();
  const menu = useMemo<BoardCardMenu | undefined>(
    () =>
      menuCapabilities && onMenuAction
        ? { capabilities: menuCapabilities, labels: menuLabels, onAction: onMenuAction }
        : undefined,
    [menuCapabilities, onMenuAction, menuLabels],
  );
  const [expanded, setExpanded] = useState(false);
  const expand = useCallback(() => setExpanded(true), []);
  const shownItems = collapsible && !expanded ? collapsedAtGymRows(items, isSelectedItem) : items;
  return (
    <View style={styles.gutter}>
      <InsetGroupedList testID={testID}>
        {shownItems.map((item) => (
          <BoardRow
            key={item.key}
            item={item}
            onPress={onSelect}
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
