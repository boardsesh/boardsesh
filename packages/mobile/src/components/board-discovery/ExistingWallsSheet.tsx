// Shown when createBoard refuses with BOARD_EXISTING_WALLS (#8151): the gym
// the board lands on already has this wall. Covers every way there: a climber
// who picked the gym, one whose typed location auto-attached a gym, and one
// who changed the gym or the board type in the form.
//
// Built like BoardDuplicatePromptSheet beside it, and never shown together
// with it: the create screen raises one refusal's sheet at a time. Rows use
// the wall; "Keep setting up mine" resends as CONFIRMED_SEPARATE with the
// walls shown. Dismissing means "keep editing" and nothing else.

import { memo, useCallback, type ComponentType } from 'react';
import { ActivityIndicator, StyleSheet, View, type FlatListProps } from 'react-native';
import { BottomSheetFlatList } from '@expo/ui/community/bottom-sheet';
import { useTranslation } from 'react-i18next';
import { ModalSheet } from '../ModalSheet';
import { SheetTopBar } from '../SheetTopBar';
import { Text } from '../Text';
import { Button } from '../Button';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { MEDIUM_LARGE_SNAP_POINTS } from '../sheet-snap-points';
import type { DiscoveryBoardItem } from './BoardDiscoveryCardView';
import type { DiscoveryBoardArtProps } from './DiscoveryBoardArt';
import { BoardRow } from './BoardRow';
import { InsetGroupedCell } from '../gym-page/InsetGroupedCell';
import { groupedCellPosition, type GroupedCellPosition } from '../gym-page/gym-page-view-model';

type ExistingWallsSheetProps = {
  /** The gym the walls are at, when known (an auto-attached gym may not be). */
  gymName: string | null;
  /** "MoonBoard", for the title. */
  boardLabel: string;
  /** Walls the refusal named. */
  wallCount: number;
  items: readonly DiscoveryBoardItem[];
  /** The walls are still being looked up. */
  loading: boolean;
  /**
   * Some named wall couldn't be shown. Keep setting up mine still works for
   * the walls that were, and the server names the rest again; Try again looks
   * them all up afresh.
   */
  loadFailed: boolean;
  /** A choice is in flight: everything is inert. */
  busy: boolean;
  onUse: (item: DiscoveryBoardItem, position: number) => void;
  onKeepMine: () => void;
  onRetry: () => void;
  onDismiss: () => void;
  BoardArt: ComponentType<DiscoveryBoardArtProps>;
};

export const ExistingWallsSheet = memo(function ExistingWallsSheet({
  gymName,
  boardLabel,
  wallCount,
  items,
  loading,
  loadFailed,
  busy,
  onUse,
  onKeepMine,
  onRetry,
  onDismiss,
  BoardArt,
}: ExistingWallsSheetProps) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();

  const title = gymName
    ? t('mobile.create.existingWalls.title', { gym: gymName, count: wallCount, board: boardLabel })
    : t('mobile.create.existingWalls.titleNoGym', { count: wallCount, board: boardLabel });

  // The rows are the sheet's own virtualized list, so any number of walls
  // scrolls inside the sheet. The choices sit above them, in the list's
  // header: they are in reach the moment the sheet opens, however many walls
  // follow, and the repo keeps actions out of a pinned footer.
  const renderItem = useCallback(
    ({ item, index }: { item: DiscoveryBoardItem; index: number }) => (
      <SheetWallCell
        item={item}
        position={groupedCellPosition(index, items.length)}
        index={index}
        onSelect={busy ? NOOP_SELECT : onUse}
        BoardArt={BoardArt}
      />
    ),
    [items.length, busy, onUse, BoardArt],
  );
  const handleUseFirst = useCallback(() => {
    const first = items[0];
    if (first) onUse(first, 0);
  }, [items, onUse]);

  const listHeader = (
    <View style={styles.content} testID="existing-walls-sheet">
      <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.centered}>
        {loadFailed ? t('mobile.create.existingWalls.loadFailed') : t('mobile.create.existingWalls.body')}
      </Text>
      {loading ? <ActivityIndicator size="small" color={systemColors.accent} /> : null}
      {loadFailed && !loading ? (
        <Button
          title={t('mobile.findWall.retry')}
          onPress={onRetry}
          disabled={busy}
          variant="text"
          size="medium"
          testID="existing-walls-retry"
        />
      ) : null}
      {items.length > 0 ? (
        <Button
          title={t('mobile.create.existingWalls.useBoard')}
          onPress={handleUseFirst}
          disabled={busy}
          loading={busy}
          size="medium"
          style={styles.fullWidth}
        />
      ) : null}
      {/* Only for walls the climber has seen: acknowledging one they never
          saw would let a copy through unchecked. */}
      {items.length > 0 ? (
        <Button
          title={t('mobile.create.existingWalls.keepMine')}
          onPress={onKeepMine}
          disabled={busy}
          variant="tonal"
          size="medium"
          style={styles.fullWidth}
        />
      ) : null}
    </View>
  );

  return (
    <ModalSheet
      visible
      snapPoints={MEDIUM_LARGE_SNAP_POINTS}
      enablePanDownToClose={!busy}
      onClose={onDismiss}
      header={
        <SheetTopBar
          title={title}
          leading={{
            kind: 'close',
            onPress: busy ? NOOP : onDismiss,
            accessibilityLabel: t('mobile.create.duplicate.cancel'),
          }}
        />
      }
    >
      <SheetWallList
        style={styles.list}
        data={items}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        ListHeaderComponent={listHeader}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        testID="existing-walls-rows"
      />
    </ModalSheet>
  );
});

/** One wall, its own slice of the card, so the sheet's list can virtualize it. */
const SheetWallCell = memo(function SheetWallCell({
  item,
  position,
  index,
  onSelect,
  BoardArt,
}: {
  item: DiscoveryBoardItem;
  position: GroupedCellPosition;
  index: number;
  onSelect: (item: DiscoveryBoardItem, position: number) => void;
  BoardArt: ComponentType<DiscoveryBoardArtProps>;
}) {
  const handlePress = useCallback((pressed: DiscoveryBoardItem) => onSelect(pressed, index), [onSelect, index]);
  return (
    <InsetGroupedCell position={position} separatorInset="regular">
      <BoardRow item={item} onPress={handlePress} BoardArt={BoardArt} />
    </InsetGroupedCell>
  );
});

const keyExtractor = (item: DiscoveryBoardItem) => item.key;

// The sheet's own list, so the sheet's scroll owns the drag.
const SheetWallList = BottomSheetFlatList as unknown as ComponentType<FlatListProps<DiscoveryBoardItem>>;

function NOOP_SELECT() {}
function NOOP() {}

const styles = StyleSheet.create({
  content: {
    paddingTop: spacing[3],
    paddingBottom: spacing[4],
    gap: spacing[3],
  },
  centered: {
    textAlign: 'center',
    paddingHorizontal: spacing[4],
  },
  fullWidth: {
    alignSelf: 'stretch',
    marginHorizontal: spacing[4],
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingBottom: spacing[4],
    gap: 0,
  },
});
