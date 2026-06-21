import { useCallback, useMemo, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { openClimbInPlayDrawer } from '../../lib/open-climb-in-play-drawer';
import { getCreateBoardHolds } from '../../lib/create-board-holds';
import { spacing } from '../../theme/tokens';
import { iosSystemColors } from '../../theme/ios-colors';
import { HoldRoleSheet } from './HoldRoleSheet';
import { CreateDrawer } from './CreateDrawer';
import { useCreateClimbScreen, type CreateClimbBoard } from './use-create-climb-screen';

type CreateClimbScreenProps = {
  board: CreateClimbBoard;
  forkFrames?: string;
  forkName?: string;
  forkDescription?: string;
  editClimbUuid?: string;
};

/**
 * The create-climb editor screen: a single Play Drawer-style sheet (the
 * CreateDrawer) carrying the header, the board, the brush + action rows, the
 * metadata form, and the Open Drafts table. The long-press role picker stacks
 * above the drawer. A successful publish dismisses the screen so the success
 * toast lands over the climbs list.
 */
export function CreateClimbScreen({
  board,
  forkFrames,
  forkName,
  forkDescription,
  editClimbUuid,
}: CreateClimbScreenProps) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();
  const router = useRouter();
  const { openPlayDrawer } = useDrawerHost();

  const controller = useCreateClimbScreen({
    board,
    forkFrames,
    forkName,
    forkDescription,
    editClimbUuid,
    onPublished: () => router.back(),
  });

  const [longPressHoldId, setLongPressHoldId] = useState<number | null>(null);

  const boardHolds = useMemo(
    () =>
      getCreateBoardHolds({
        boardName: board.boardName,
        layoutId: board.layoutId,
        sizeId: board.sizeId,
        setIds: board.setIds.split(',').map(Number),
      }),
    [board.boardName, board.layoutId, board.sizeId, board.setIds],
  );

  const handleLongPress = useCallback((holdId: number) => setLongPressHoldId(holdId), []);
  const closeHoldRole = useCallback(() => setLongPressHoldId(null), []);

  const handleLoadDraft = useCallback(
    (climb: Climb) => {
      // Re-enter the screen in edit mode for the picked draft so the controller
      // re-seeds holds/name/description cleanly. The route's key (editClimbUuid)
      // forces a remount, giving a fresh editing session + undo history.
      router.replace({
        pathname: '/(tabs)/climbs/create',
        params: {
          editClimbUuid: climb.uuid,
          boardName: board.boardName,
          layoutId: String(board.layoutId),
          sizeId: String(board.sizeId),
          setIds: board.setIds,
          angle: String(board.angle),
        },
      });
    },
    [router, board],
  );

  const handleViewDuplicate = useCallback(
    (uuid: string) => {
      // Only a uuid + the active board config is on hand here (no climb frames),
      // so open via the `ref` branch — it loads the full climb by uuid, then
      // hands off to the play drawer.
      openClimbInPlayDrawer(
        {
          kind: 'ref',
          climbUuid: uuid,
          boardType: board.boardName,
          layoutId: board.layoutId,
          angle: board.angle,
          sizeId: board.sizeId,
          setIds: board.setIds,
        },
        { openPlayDrawer, router },
      );
    },
    [openPlayDrawer, router, board],
  );

  if (!boardHolds) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: systemColors.background }]} edges={['bottom']}>
        <View style={styles.centered}>
          <Icon name="boards" size={48} color={iosSystemColors.systemGray4} />
          <Text variant="headline" style={styles.centeredTitle}>
            {t('mobile.create.unavailable.title')}
          </Text>
          <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.centeredSubtitle}>
            {t('mobile.create.unavailable.subtitle')}
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    // Transparent so the create drawer floats over the climbs/search list (dimmed
    // by the drawer's own backdrop) — no separate modal card.
    <View style={styles.container}>
      <CreateDrawer
        board={board}
        controller={controller}
        boardHolds={boardHolds}
        onLongPressHold={handleLongPress}
        subSheetOpen={longPressHoldId !== null}
        onLoadDraft={handleLoadDraft}
        onClose={() => router.back()}
        onViewDuplicate={handleViewDuplicate}
      />

      <HoldRoleSheet
        holdId={longPressHoldId}
        boardName={board.boardName as BoardName}
        litUpHoldsMap={controller.litUpHoldsMap}
        startingCount={controller.startingCount}
        finishCount={controller.finishCount}
        onSelectRole={controller.handleAssignRole}
        onClose={closeHoldRole}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[6],
  },
  centeredTitle: {
    marginTop: spacing[2],
  },
  centeredSubtitle: {
    textAlign: 'center',
  },
});
