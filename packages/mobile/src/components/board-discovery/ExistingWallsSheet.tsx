// Shown when createBoard refuses with BOARD_EXISTING_WALLS (#8151): the gym
// the board lands on already has this wall. Covers every way there: a climber
// who picked the gym, one whose typed location auto-attached a gym, and one
// who changed the gym or the board type in the form.
//
// Built like BoardDuplicatePromptSheet beside it, and never shown together
// with it: the create screen raises one refusal's sheet at a time. Shelves,
// in order: Same setup, Set up differently (the same layout and size with
// other hold sets) and Possible setup mismatch (another layout or size, which
// never blocks a save but is often the same wall entered wrong).
//
// A same-setup row is "Use this board". A near-miss row asks "Is this your
// wall?" in this same sheet, never a second one stacked on it (the coordinator
// rule in docs/mobile/mobile-sheets-vs-routes.md): use it as it is, use it and
// fix its setup, or go back. "Keep setting up mine" resends as
// CONFIRMED_SEPARATE with the walls the refusal named. Dismissing means "keep
// editing" and nothing else.

import { memo, useCallback, useMemo, useState, type ComponentType, type Ref } from 'react';
import { ActivityIndicator, StyleSheet, View, type FlatListProps } from 'react-native';
import { BottomSheetFlatList } from '@expo/ui/community/bottom-sheet';
import { useTranslation } from 'react-i18next';
import { ModalSheet } from '../ModalSheet';
import { SheetTopBar } from '../SheetTopBar';
import { Text } from '../Text';
import { Button } from '../Button';
import { useTheme } from '../../providers/theme-provider';
import type { ManagedSheetHandle } from '../../providers/sheet-presentation-provider';
import { spacing } from '../../theme/tokens';
import { MEDIUM_LARGE_SNAP_POINTS } from '../sheet-snap-points';
import type { DiscoveryBoardItem } from './BoardDiscoveryCardView';
import type { DiscoveryBoardArtProps } from './DiscoveryBoardArt';
import { BoardRow } from './BoardRow';
import { InsetGroupedCell } from '../gym-page/InsetGroupedCell';
import { groupedCellPosition, type GroupedCellPosition } from '../gym-page/gym-page-view-model';
import type { ExistingWallShelfKey } from '../../lib/boards/near-miss-walls';

export type ExistingWallsSheetShelf = { key: ExistingWallShelfKey; items: readonly DiscoveryBoardItem[] };

/** A tap on a wall, with its 0-based place in its shelf and the shelf it's on. */
export type ExistingWallPick = (item: DiscoveryBoardItem, position: number, shelf: ExistingWallShelfKey) => void;

/**
 * One cell of the sheet's list: a shelf's title, or one wall, its own slice of
 * that shelf's card, so the list virtualizes per wall.
 */
export type ExistingWallsSheetCell =
  | { kind: 'title'; key: string; shelf: ExistingWallShelfKey }
  | {
      kind: 'wall';
      key: string;
      item: DiscoveryBoardItem;
      shelf: ExistingWallShelfKey;
      /** Its 0-based place in its shelf. */
      index: number;
      position: GroupedCellPosition;
    };

/**
 * The shelves as the list's cells, in order. Titles only when the sheet has
 * more than one kind of wall, or its one kind isn't the same setup.
 */
export function existingWallsSheetCells(shelves: readonly ExistingWallsSheetShelf[]): ExistingWallsSheetCell[] {
  const first = shelves[0];
  const showTitles = shelves.length > 1 || (first !== undefined && first.key !== 'same_setup');
  return shelves.flatMap((shelf): ExistingWallsSheetCell[] => {
    if (shelf.items.length === 0) return [];
    const walls = shelf.items.map((item, index): ExistingWallsSheetCell => ({
      kind: 'wall',
      key: `${shelf.key}:${item.key}`,
      item,
      shelf: shelf.key,
      index,
      position: groupedCellPosition(index, shelf.items.length),
    }));
    return showTitles ? [{ kind: 'title', key: `title:${shelf.key}`, shelf: shelf.key }, ...walls] : walls;
  });
}

type ExistingWallsSheetProps = {
  /** The gym the walls are at, when known (an auto-attached gym may not be). */
  gymName: string | null;
  /** "MoonBoard", for the title. */
  boardLabel: string;
  /** Walls on the sheet, for its title. */
  wallCount: number;
  /** The walls, same setup first. Empty shelves are left out by the caller. */
  shelves: readonly ExistingWallsSheetShelf[];
  /**
   * Walls whose setup the climber may suggest a fix for, by item key: "Use it
   * and fix its setup" shows only for these (Report a problem is on, and the
   * wall isn't one the climber can edit themselves).
   */
  fixableKeys: ReadonlySet<string>;
  /** Some wall the refusal named was shown, so it can be acknowledged. */
  canKeepMine: boolean;
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
  /** Take the wall as it is: same setup, or "Use it as it is". */
  onUse: ExistingWallPick;
  /** "Use it and fix its setup". */
  onFixSetup: ExistingWallPick;
  onKeepMine: () => void;
  onRetry: () => void;
  onDismiss: () => void;
  BoardArt: ComponentType<DiscoveryBoardArtProps>;
  /** So the host can dismiss this sheet and wait before presenting the report sheet. */
  sheetRef?: Ref<ManagedSheetHandle>;
};

type NearMissChoice = { item: DiscoveryBoardItem; position: number; shelf: ExistingWallShelfKey };

export const ExistingWallsSheet = memo(function ExistingWallsSheet({
  gymName,
  boardLabel,
  wallCount,
  shelves,
  fixableKeys,
  canKeepMine,
  loading,
  loadFailed,
  busy,
  onUse,
  onFixSetup,
  onKeepMine,
  onRetry,
  onDismiss,
  BoardArt,
  sheetRef,
}: ExistingWallsSheetProps) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  // The near-miss wall being asked about, or null for the list.
  const [choice, setChoice] = useState<NearMissChoice | null>(null);
  // Which answer was tapped, so only that button spins while it runs.
  const [answer, setAnswer] = useState<'as_is' | 'fix' | null>(null);
  const backToList = useCallback(() => {
    setChoice(null);
    setAnswer(null);
  }, []);

  const pick = useCallback<ExistingWallPick>(
    (item, position, shelf) => {
      if (busy) return;
      if (shelf === 'same_setup') onUse(item, position, shelf);
      else setChoice({ item, position, shelf });
    },
    [busy, onUse],
  );

  const title = choice
    ? t('mobile.create.existingWalls.choiceTitle')
    : gymName
      ? t('mobile.create.existingWalls.title', { gym: gymName, count: wallCount, board: boardLabel })
      : t('mobile.create.existingWalls.titleNoGym', { count: wallCount, board: boardLabel });

  const cells = useMemo(() => existingWallsSheetCells(shelves), [shelves]);
  const firstShelf = shelves[0];
  const firstSameSetup = firstShelf?.key === 'same_setup' ? firstShelf.items[0] : undefined;
  const handleUseFirst = useCallback(() => {
    if (firstSameSetup) onUse(firstSameSetup, 0, 'same_setup');
  }, [firstSameSetup, onUse]);

  // The rows are the sheet's own virtualized list, so any number of walls
  // scrolls inside the sheet. The choices sit above them, in the list's
  // header: they are in reach the moment the sheet opens, however many walls
  // follow, and the repo keeps actions out of a pinned footer.
  const renderItem = useCallback(
    ({ item: cell }: { item: ExistingWallsSheetCell }) =>
      cell.kind === 'title' ? (
        <ShelfTitle shelf={cell.shelf} />
      ) : (
        <SheetWallCell
          item={cell.item}
          position={cell.position}
          index={cell.index}
          shelf={cell.shelf}
          onSelect={pick}
          BoardArt={BoardArt}
        />
      ),
    [pick, BoardArt],
  );

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
      {firstSameSetup ? (
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
      {canKeepMine ? (
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
      ref={sheetRef}
      visible
      snapPoints={MEDIUM_LARGE_SNAP_POINTS}
      enablePanDownToClose={!busy}
      onClose={onDismiss}
      header={
        <SheetTopBar
          title={title}
          leading={
            choice
              ? {
                  kind: 'back',
                  onPress: busy ? NOOP : backToList,
                  accessibilityLabel: t('mobile.create.existingWalls.choiceDifferent'),
                }
              : {
                  kind: 'close',
                  onPress: busy ? NOOP : onDismiss,
                  accessibilityLabel: t('mobile.create.duplicate.cancel'),
                }
          }
        />
      }
    >
      {choice ? (
        <View style={styles.content} testID="existing-walls-choice">
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.centered}>
            {t('mobile.create.existingWalls.choiceBody')}
          </Text>
          {/* The wall in question, as words: nothing here is a tap target but
              the answers below. */}
          <View style={styles.choiceWall} testID="existing-walls-choice-wall">
            <Text variant="headline">{choice.item.title}</Text>
            {choice.item.subtitle ? (
              <Text variant="footnote" color={systemColors.secondaryLabel}>
                {choice.item.subtitle}
              </Text>
            ) : null}
            {(choice.item.detailLines ?? []).map((line) => (
              <Text key={line} variant="footnote" color={systemColors.secondaryLabel}>
                {line}
              </Text>
            ))}
          </View>
          <Button
            title={t('mobile.create.existingWalls.choiceUseAsIs')}
            onPress={() => {
              setAnswer('as_is');
              onUse(choice.item, choice.position, choice.shelf);
            }}
            disabled={busy}
            loading={busy && answer === 'as_is'}
            size="medium"
            style={styles.fullWidth}
          />
          {fixableKeys.has(choice.item.key) ? (
            <Button
              title={t('mobile.create.existingWalls.choiceFixSetup')}
              onPress={() => {
                setAnswer('fix');
                onFixSetup(choice.item, choice.position, choice.shelf);
              }}
              disabled={busy}
              loading={busy && answer === 'fix'}
              variant="tonal"
              size="medium"
              style={styles.fullWidth}
            />
          ) : null}
          <Button
            title={t('mobile.create.existingWalls.choiceDifferent')}
            onPress={backToList}
            disabled={busy}
            variant="text"
            size="medium"
          />
        </View>
      ) : (
        <SheetWallList
          style={styles.list}
          data={cells}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          ListHeaderComponent={listHeader}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          testID="existing-walls-rows"
        />
      )}
    </ModalSheet>
  );
});

/** A shelf's title, its own cell in the list. */
const ShelfTitle = memo(function ShelfTitle({ shelf }: { shelf: ExistingWallShelfKey }) {
  const { t } = useTranslation('boards');
  return (
    <Text
      variant="subheadline"
      tone="secondary"
      style={styles.shelfTitle}
      accessibilityRole="header"
      testID={`existing-walls-shelf-${shelf}`}
    >
      {shelf === 'same_setup'
        ? t('mobile.findWall.sameSetup')
        : shelf === 'set_up_differently'
          ? t('mobile.findWall.setUpDifferently')
          : t('mobile.create.existingWalls.setupMismatch')}
    </Text>
  );
});

/** One wall, its own slice of its shelf's card, so the sheet's list can virtualize it. */
const SheetWallCell = memo(function SheetWallCell({
  item,
  position,
  index,
  shelf,
  onSelect,
  BoardArt,
}: {
  item: DiscoveryBoardItem;
  position: GroupedCellPosition;
  index: number;
  shelf: ExistingWallShelfKey;
  onSelect: ExistingWallPick;
  BoardArt: ComponentType<DiscoveryBoardArtProps>;
}) {
  const handlePress = useCallback(
    (pressed: DiscoveryBoardItem) => onSelect(pressed, index, shelf),
    [onSelect, index, shelf],
  );
  return (
    <InsetGroupedCell position={position} separatorInset="regular">
      <BoardRow item={item} onPress={handlePress} BoardArt={BoardArt} />
    </InsetGroupedCell>
  );
});

const keyExtractor = (cell: ExistingWallsSheetCell) => cell.key;

// The sheet's own list, so the sheet's scroll owns the drag.
const SheetWallList = BottomSheetFlatList as unknown as ComponentType<FlatListProps<ExistingWallsSheetCell>>;

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
  shelfTitle: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    paddingBottom: spacing[2],
  },
  choiceWall: {
    gap: spacing[1],
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
