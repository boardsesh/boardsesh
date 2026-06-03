import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, StyleSheet, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import type { BoardName } from '@boardsesh/shared-schema';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import type { getCreateBoardHolds } from '../../lib/create-board-holds';
import { InteractiveCreateBoard } from './InteractiveCreateBoard';
import { MoonBoardBackground } from './MoonBoardBackground';
import { BrushBar } from './BrushBar';
import { HoldRoleSheet } from './HoldRoleSheet';
import { MoonBoardSettingsSheet } from './MoonBoardSettingsSheet';
import { CreateClimbDuplicateBanner } from './CreateClimbDuplicateBanner';
import { MOONBOARD_PAINT_ROLES } from './brush-roles';
import { useMoonBoardCreateScreen } from './use-moonboard-create-screen';
import type { CreateClimbBoard } from './use-create-climb-screen';

type MoonBoardCreateClimbScreenProps = {
  board: CreateClimbBoard;
  boardHolds: NonNullable<ReturnType<typeof getCreateBoardHolds>>;
};

/**
 * The MoonBoard create-climb editor: the interactive board (stacked MoonBoard
 * webp background), the persistent brush bar (Start/Hand/Finish + erase, no
 * foot), the long-press role sheet, and the MoonBoard settings sheet (grade /
 * benchmark / angle). Create-only — no fork / edit / drafts-drawer path.
 */
export function MoonBoardCreateClimbScreen({ board, boardHolds }: MoonBoardCreateClimbScreenProps) {
  const { systemColors } = useTheme();
  const router = useRouter();

  const controller = useMoonBoardCreateScreen({ board });

  const [longPressHoldId, setLongPressHoldId] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    if (controller.openSettingsSignal > 0) setSettingsOpen(true);
  }, [controller.openSettingsSignal]);

  const setIds = useMemo(() => board.setIds.split(',').map(Number).filter(Boolean), [board.setIds]);

  const handleLongPress = useCallback((holdId: number) => setLongPressHoldId(holdId), []);
  const closeHoldRole = useCallback(() => setLongPressHoldId(null), []);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: systemColors.background }]} edges={['bottom']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.boardArea}>
          <InteractiveCreateBoard
            background={<MoonBoardBackground layoutId={board.layoutId} setIds={setIds} />}
            boardWidth={boardHolds.boardWidth}
            boardHeight={boardHolds.boardHeight}
            holdTargets={boardHolds.holdTargets}
            litUpHoldsMap={controller.litUpHoldsMap}
            onPaint={controller.handlePaint}
            onLongPressHold={handleLongPress}
            showAllHolds={controller.showAllHolds}
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
                        angle: String(controller.angle),
                      },
                    });
                  }
                : undefined
            }
            onDismiss={controller.dismissDuplicateError}
          />
        ) : null}

        <View style={styles.barArea}>
          <BrushBar
            boardName={board.boardName as BoardName}
            selectedBrush={controller.selectedBrush}
            onSelectBrush={controller.setSelectedBrush}
            paintRoles={MOONBOARD_PAINT_ROLES}
            startingCount={controller.startingCount}
            finishCount={controller.finishCount}
            saveState={controller.saveState}
            onSave={() => void controller.handleSave()}
            onClear={controller.handleClear}
            onOpenSettings={() => setSettingsOpen(true)}
            onSetActive={controller.handleSetActive}
            canSetActive={controller.canSetActive}
          />
        </View>
      </KeyboardAvoidingView>

      <HoldRoleSheet
        holdId={longPressHoldId}
        boardName={board.boardName as BoardName}
        litUpHoldsMap={controller.litUpHoldsMap}
        startingCount={controller.startingCount}
        finishCount={controller.finishCount}
        paintRoles={MOONBOARD_PAINT_ROLES}
        onSelectRole={controller.handleAssignRole}
        onClose={closeHoldRole}
      />

      <MoonBoardSettingsSheet
        visible={settingsOpen}
        name={controller.name}
        description={controller.description}
        isDraft={controller.isDraft}
        showAllHolds={controller.showAllHolds}
        angle={controller.angle}
        userGrade={controller.userGrade}
        isBenchmark={controller.isBenchmark}
        onChangeName={controller.setName}
        onChangeDescription={controller.setDescription}
        onChangeIsDraft={controller.setIsDraft}
        onChangeShowAllHolds={controller.setShowAllHolds}
        onChangeAngle={controller.setAngle}
        onChangeUserGrade={controller.setUserGrade}
        onChangeIsBenchmark={controller.setIsBenchmark}
        bleAvailable={controller.bleAvailable}
        bleConnected={controller.bleConnected}
        bleConnecting={controller.bleConnecting}
        onConnectBoard={controller.handleConnectBoard}
        onDismiss={() => setSettingsOpen(false)}
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
});
