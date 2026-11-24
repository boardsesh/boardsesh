// Shown when createBoard refuses with BOARD_EXISTING_WALLS (#8151): the gym
// the board lands on already has this wall. Covers every way there: a climber
// who picked the gym, one whose typed location auto-attached a gym, and one
// who changed the gym or the board type in the form.
//
// Built like BoardDuplicatePromptSheet beside it, and never shown together
// with it: the create screen raises one refusal's sheet at a time. Rows use
// the wall; "Keep setting up mine" resends as CONFIRMED_SEPARATE with every
// wall the refusal named. Dismissing means "keep editing" and nothing else.

import { memo, type ComponentType } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
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
import { BoardRowList } from './BoardRowList';

/** Rows the sheet shows before "Show all". */
const SHEET_COLLAPSED_ROW_COUNT = 3;

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
  /** The lookup failed: the title and Keep setting up mine still work. */
  loadFailed: boolean;
  /** A choice is in flight: everything is inert. */
  busy: boolean;
  onUse: (item: DiscoveryBoardItem, position: number) => void;
  onKeepMine: () => void;
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
  onDismiss,
  BoardArt,
}: ExistingWallsSheetProps) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();

  const title = gymName
    ? wallCount === 1
      ? t('mobile.create.existingWalls.titleOne', { gym: gymName, board: boardLabel })
      : t('mobile.create.existingWalls.title', { gym: gymName, n: wallCount, board: boardLabel })
    : t('mobile.create.existingWalls.titleNoGym', { n: wallCount, board: boardLabel });
  const firstItem = items[0];

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
            onPress: busy ? () => {} : onDismiss,
            accessibilityLabel: t('mobile.create.duplicate.cancel'),
          }}
        />
      }
    >
      <View style={styles.content} testID="existing-walls-sheet">
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.centered}>
          {loadFailed ? t('mobile.create.existingWalls.loadFailed') : t('mobile.create.existingWalls.body')}
        </Text>
        {loading ? <ActivityIndicator size="small" color={systemColors.accent} /> : null}
        {items.length > 0 ? (
          <BoardRowList
            items={items}
            onSelect={busy ? NOOP_SELECT : onUse}
            collapsedRowCount={SHEET_COLLAPSED_ROW_COUNT}
            BoardArt={BoardArt}
            testID="existing-walls-rows"
          />
        ) : null}
        {firstItem ? (
          <Button
            title={t('mobile.create.existingWalls.useBoard')}
            onPress={() => onUse(firstItem, 0)}
            disabled={busy}
            loading={busy}
            size="medium"
            style={styles.fullWidth}
          />
        ) : null}
        <Button
          title={t('mobile.create.existingWalls.keepMine')}
          onPress={onKeepMine}
          disabled={busy}
          variant="tonal"
          size="medium"
          style={styles.fullWidth}
        />
      </View>
    </ModalSheet>
  );
});

function NOOP_SELECT() {}

const styles = StyleSheet.create({
  content: {
    paddingTop: spacing[3],
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
});
