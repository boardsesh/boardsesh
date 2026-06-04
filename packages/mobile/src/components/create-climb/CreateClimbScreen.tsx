import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, StyleSheet, KeyboardAvoidingView, Platform, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { BoardName } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { getCreateBoardHolds } from '../../lib/create-board-holds';
import { spacing } from '../../theme/tokens';
import { brandColors } from '../../theme/colors';
import { iosSystemColors } from '../../theme/ios-colors';
import { BoardImageNative } from '../BoardImageNative';
import { useHoldHeatmap } from '../../lib/graphql/hooks';
import { InteractiveCreateBoard } from './InteractiveCreateBoard';
import { HeatmapOverlay } from './HeatmapOverlay';
import { BrushBar } from './BrushBar';
import { HoldRoleSheet } from './HoldRoleSheet';
import { CreateClimbSettingsSheet } from './CreateClimbSettingsSheet';
import { DraftsSheet } from './DraftsSheet';
import { MoonBoardCreateClimbScreen } from './MoonBoardCreateClimbScreen';
import { CreateClimbDuplicateBanner } from './CreateClimbDuplicateBanner';
import { useCreateClimbScreen, type CreateClimbBoard } from './use-create-climb-screen';

type CreateClimbScreenProps = {
  board: CreateClimbBoard;
  forkFrames?: string;
  forkName?: string;
  forkDescription?: string;
  editClimbUuid?: string;
};

/**
 * The create-climb editor screen: the interactive board, the persistent brush
 * bar, and the long-press / settings / drafts sheets. Composes the controller
 * hook with the no-SVG board renderer.
 */
/**
 * Create-climb editor router. Resolves the board's hold geometry, then renders
 * either the MoonBoard variant (create-only; Start/Hand/Finish brush; grade /
 * benchmark / angle fields) or the Aurora variant. The unavailable state covers
 * an unknown board / layout combination for either family.
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
    // MoonBoard is create-only — fork/edit params are intentionally not threaded
    // here (Edit is disabled for moonboard in ClimbActionsSheet, and there's no
    // MoonBoard drafts/edit entry point).
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
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();
  const { showToast } = useToast();
  const router = useRouter();

  const controller = useCreateClimbScreen({ board, forkFrames, forkName, forkDescription, editClimbUuid });

  const [longPressHoldId, setLongPressHoldId] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftsOpen, setDraftsOpen] = useState(false);
  const [heatmapVisible, setHeatmapVisible] = useState(false);

  // The controller asks the screen to open settings (e.g. an unnamed save).
  useEffect(() => {
    if (controller.openSettingsSignal > 0) setSettingsOpen(true);
  }, [controller.openSettingsSignal]);

  const handleLongPress = useCallback((holdId: number) => setLongPressHoldId(holdId), []);
  const closeHoldRole = useCallback(() => setLongPressHoldId(null), []);

  // Community hold-usage heatmap. Only fetched once the user toggles it on.
  const { statsByHoldId, isError: heatmapError } = useHoldHeatmap(
    {
      boardName: board.boardName,
      layoutId: board.layoutId,
      sizeId: board.sizeId,
      setIds: board.setIds,
      angle: board.angle,
    },
    heatmapVisible,
  );

  // A failed heatmap fetch would otherwise leave the flame toggle lit over an
  // empty overlay with no feedback. Drop the overlay and surface the failure.
  useEffect(() => {
    if (heatmapVisible && heatmapError) {
      setHeatmapVisible(false);
      showToast(t('createClimbForm.alerts.heatmapLoadFailed'), 'error');
    }
  }, [heatmapVisible, heatmapError, showToast, t]);

  // Skip painted holds so the heat never covers the working climb.
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

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: systemColors.background }]} edges={['bottom']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.boardArea}>
          <InteractiveCreateBoard
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
            boardWidth={boardHolds.boardWidth}
            boardHeight={boardHolds.boardHeight}
            holdTargets={boardHolds.holdTargets}
            litUpHoldsMap={controller.litUpHoldsMap}
            onPaint={controller.handlePaint}
            onLongPressHold={handleLongPress}
            showAllHolds={controller.showAllHolds}
            overlay={heatmapOverlay}
          />
        </View>

        {controller.publishDuplicateError ? (
          <CreateClimbDuplicateBanner
            name={controller.publishDuplicateError.existingClimbName}
            onView={
              controller.publishDuplicateError.existingClimbUuid
                ? () => {
                    const uuid = controller.publishDuplicateError?.existingClimbUuid;
                    if (!uuid) return;
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
                  }
                : undefined
            }
            onDismiss={controller.dismissDuplicateError}
          />
        ) : null}

        <View style={styles.barArea}>
          <Pressable
            onPress={() => setDraftsOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={t('createClimbForm.openDrafts')}
            style={styles.draftsLink}
          >
            <Icon name="history" size={16} color={brandColors.primary} />
            <Text variant="footnote" color={brandColors.primary}>
              {t('createClimbForm.openDrafts')}
            </Text>
          </Pressable>
          <BrushBar
            boardName={board.boardName as BoardName}
            selectedBrush={controller.selectedBrush}
            onSelectBrush={controller.setSelectedBrush}
            startingCount={controller.startingCount}
            finishCount={controller.finishCount}
            saveState={controller.saveState}
            onSave={() => void controller.handleSave()}
            onClear={controller.handleClear}
            onOpenSettings={() => setSettingsOpen(true)}
            onSetActive={controller.handleSetActive}
            canSetActive={controller.canSetActive}
            onToggleHeatmap={() => setHeatmapVisible((visible) => !visible)}
            heatmapActive={heatmapVisible}
          />
        </View>
      </KeyboardAvoidingView>

      <HoldRoleSheet
        holdId={longPressHoldId}
        boardName={board.boardName as BoardName}
        litUpHoldsMap={controller.litUpHoldsMap}
        startingCount={controller.startingCount}
        finishCount={controller.finishCount}
        onSelectRole={controller.handleAssignRole}
        onClose={closeHoldRole}
      />

      <CreateClimbSettingsSheet
        visible={settingsOpen}
        name={controller.name}
        description={controller.description}
        isDraft={controller.isDraft}
        showAllHolds={controller.showAllHolds}
        onChangeName={controller.setName}
        onChangeDescription={controller.setDescription}
        onChangeIsDraft={controller.setIsDraft}
        onChangeShowAllHolds={controller.setShowAllHolds}
        bleAvailable={controller.bleAvailable}
        bleConnected={controller.bleConnected}
        bleConnecting={controller.bleConnecting}
        onConnectBoard={controller.handleConnectBoard}
        onDismiss={() => setSettingsOpen(false)}
      />

      <DraftsSheet
        visible={draftsOpen}
        board={board}
        onLoadDraft={(climb) => {
          // Re-enter the screen in edit mode for the picked draft so the
          // controller re-seeds holds/name/description cleanly from it (rather
          // than merging into the current working state).
          setDraftsOpen(false);
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
        }}
        onDismiss={() => setDraftsOpen(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  boardArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing[3],
  },
  barArea: {
    paddingBottom: spacing[2],
  },
  draftsLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
    alignSelf: 'flex-end',
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
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
