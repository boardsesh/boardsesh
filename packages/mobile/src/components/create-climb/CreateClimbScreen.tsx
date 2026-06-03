import { useCallback, useMemo, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { BoardImageNative } from '../BoardImageNative';
import { useTheme } from '../../providers/theme-provider';
import { getCreateBoardHolds } from '../../lib/create-board-holds';
import { useHoldHeatmap } from '../../lib/graphql/hooks';
import { spacing } from '../../theme/tokens';
import { iosSystemColors } from '../../theme/ios-colors';
import { HoldRoleSheet } from './HoldRoleSheet';
import { CreateDrawer } from './CreateDrawer';
import { CreateDrawerForm } from './CreateDrawerForm';
import { OpenDraftsSection } from './OpenDraftsSection';
import { MoonBoardCreateClimbScreen } from './MoonBoardCreateClimbScreen';
import { HeatmapOverlay } from './HeatmapOverlay';
import { useCreateClimbScreen, type CreateClimbBoard } from './use-create-climb-screen';

type CreateClimbScreenProps = {
  board: CreateClimbBoard;
  forkFrames?: string;
  forkName?: string;
  forkDescription?: string;
  editClimbUuid?: string;
};

/**
 * Create-climb editor router. Resolves hold geometry, then renders either the
 * MoonBoard variant or the Aurora drawer. The unavailable state covers unknown
 * board/layout combinations for either family.
 */
export function CreateClimbScreen(props: CreateClimbScreenProps) {
  const { board } = props;
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();

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

  if (boardHolds.family === 'moonboard') {
    return <MoonBoardCreateClimbScreen board={board} boardHolds={boardHolds} />;
  }

  return <AuroraCreateClimbScreen {...props} boardHolds={boardHolds} />;
}

type AuroraCreateClimbScreenProps = CreateClimbScreenProps & {
  boardHolds: NonNullable<ReturnType<typeof getCreateBoardHolds>>;
};

function AuroraCreateClimbScreen({
  board,
  forkFrames,
  forkName,
  forkDescription,
  editClimbUuid,
  boardHolds,
}: AuroraCreateClimbScreenProps) {
  const router = useRouter();

  const controller = useCreateClimbScreen({
    board,
    forkFrames,
    forkName,
    forkDescription,
    editClimbUuid,
    onPublished: () => router.back(),
  });

  const [longPressHoldId, setLongPressHoldId] = useState<number | null>(null);
  const [heatmapVisible, setHeatmapVisible] = useState(false);

  const handleLongPress = useCallback((holdId: number) => setLongPressHoldId(holdId), []);
  const closeHoldRole = useCallback(() => setLongPressHoldId(null), []);

  const { statsByHoldId } = useHoldHeatmap(
    {
      boardName: board.boardName,
      layoutId: board.layoutId,
      sizeId: board.sizeId,
      setIds: board.setIds,
      angle: board.angle,
    },
    heatmapVisible,
  );

  const paintedHoldIds = useMemo(
    () => new Set(Object.keys(controller.litUpHoldsMap).map(Number)),
    [controller.litUpHoldsMap],
  );

  const heatmapOverlay = useMemo(
    () =>
      heatmapVisible ? (
        <HeatmapOverlay
          statsByHoldId={statsByHoldId}
          holdTargets={boardHolds.holdTargets}
          boardWidth={boardHolds.boardWidth}
          boardHeight={boardHolds.boardHeight}
          paintedHoldIds={paintedHoldIds}
        />
      ) : null,
    [heatmapVisible, statsByHoldId, boardHolds, paintedHoldIds],
  );

  const handleLoadDraft = useCallback(
    (climb: Climb) => {
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
      router.push({
        pathname: '/(tabs)/climbs/[climbUuid]',
        params: {
          climbUuid: uuid,
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

  return (
    <View style={styles.container}>
      <CreateDrawer
        board={board}
        controller={controller}
        boardHolds={boardHolds}
        background={
          <BoardImageNative
            frames=""
            boardName={board.boardName as BoardName}
            layoutId={board.layoutId}
            sizeId={board.sizeId}
            setIds={board.setIds}
            boardWidth={boardHolds.boardWidth}
            boardHeight={boardHolds.boardHeight}
          />
        }
        overlay={heatmapOverlay}
        onToggleHeatmap={() => setHeatmapVisible((visible) => !visible)}
        heatmapActive={heatmapVisible}
        onLongPressHold={handleLongPress}
        subSheetOpen={longPressHoldId !== null}
        onClose={() => router.back()}
        onViewDuplicate={handleViewDuplicate}
        belowFold={
          <>
            <CreateDrawerForm
              description={controller.description}
              onChangeDescription={controller.setDescription}
              noMatch={controller.noMatch}
              onChangeNoMatch={controller.setNoMatch}
              isDraft={controller.isDraft}
              onChangeIsDraft={controller.setIsDraft}
              showAllHolds={controller.showAllHolds}
              onChangeShowAllHolds={controller.setShowAllHolds}
            />
            <OpenDraftsSection board={board} onLoadDraft={handleLoadDraft} />
          </>
        }
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
