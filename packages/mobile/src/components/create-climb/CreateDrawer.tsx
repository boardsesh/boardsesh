import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { View, StyleSheet, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import BottomSheet, {
  BottomSheetScrollView,
  BottomSheetBackdrop,
  BottomSheetHandle,
  type BottomSheetBackdropProps,
  type BottomSheetHandleProps,
} from '@gorhom/bottom-sheet';
import type { LitUpHoldsMap } from '@boardsesh/shared-schema';
import { useTheme } from '../../providers/theme-provider';
import { spacing, sheetStyles } from '../../theme/tokens';
import type { BoardHoldTarget } from '../../lib/create-board-holds';
import { InteractiveCreateBoard } from './InteractiveCreateBoard';
import { CreateDrawerHeader } from './CreateDrawerHeader';
import { CreateDrawerActionBar } from './CreateDrawerActionBar';
import { DuplicateBanner } from './DuplicateBanner';
import type { BrushRole } from './brush-roles';
import type { CreateClimbBoard, SaveButtonState } from './use-create-climb-screen';

type PublishDuplicateError = {
  existingClimbUuid: string | null;
  existingClimbName: string | null;
};

type CreateDrawerController = {
  name: string;
  setName: (next: string) => void;
  startingCount: number;
  finishCount: number;
  focusNameSignal: number;
  bleConnected: boolean;
  bleConnecting: boolean;
  handleToggleBle: () => void;
  publishDuplicateError: PublishDuplicateError | null;
  dismissDuplicateError: () => void;
  litUpHoldsMap: LitUpHoldsMap;
  handlePaint: (holdId: number) => void;
  showAllHolds: boolean;
  selectedBrush: BrushRole;
  setSelectedBrush: (role: BrushRole) => void;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  handleClear: () => void;
  canSetActive: boolean;
  handleSetActive: () => void;
  saveState: SaveButtonState;
  handleSave: () => Promise<void> | void;
};

type BoardHolds = {
  holdTargets: BoardHoldTarget[];
  boardWidth: number;
  boardHeight: number;
};

type CreateDrawerProps = {
  board: CreateClimbBoard;
  controller: CreateDrawerController;
  boardHolds: BoardHolds;
  background: ReactNode;
  overlay?: ReactNode;
  paintRoles?: ReadonlyArray<Exclude<BrushRole, 'OFF'>>;
  onToggleHeatmap?: () => void;
  heatmapActive?: boolean;
  onLongPressHold: (holdId: number) => void;
  /** True while a stacked sub-sheet is open, so sub-sheet drags do not move the drawer. */
  subSheetOpen: boolean;
  /** Dismiss the create drawer. */
  onClose: () => void;
  /** Open the climb that a publish collided with. */
  onViewDuplicate: (uuid: string) => void;
  belowFold: ReactNode;
};

const ABOVE_FOLD_CHROME = 300;

/**
 * The create-climb drawer. Peek shows the header, board, and action bar;
 * dragging up reveals board-family-specific form content below the fold.
 */
export function CreateDrawer({
  board,
  controller,
  boardHolds,
  background,
  overlay,
  paintRoles,
  onToggleHeatmap,
  heatmapActive = false,
  onLongPressHold,
  subSheetOpen,
  onClose,
  onViewDuplicate,
  belowFold,
}: CreateDrawerProps) {
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const sheetRef = useRef<BottomSheet>(null);

  const [handleHeight, setHandleHeight] = useState(0);
  const [aboveFoldHeight, setAboveFoldHeight] = useState(0);
  const indexRef = useRef(0);

  const boardMaxHeight = Math.max(200, windowHeight - insets.top - insets.bottom - ABOVE_FOLD_CHROME);

  const boardRender = useMemo(() => {
    const boardAspect = boardHolds.boardWidth / boardHolds.boardHeight;
    const availableWidth = windowWidth - spacing[4] * 2;
    const availableAspect = availableWidth / boardMaxHeight;
    if (availableAspect > boardAspect) {
      return { width: boardMaxHeight * boardAspect, height: boardMaxHeight };
    }
    return { width: availableWidth, height: availableWidth / boardAspect };
  }, [boardHolds.boardWidth, boardHolds.boardHeight, windowWidth, boardMaxHeight]);

  const setHeightIfChanged = (setter: (updater: (previous: number) => number) => void, measured: number) => {
    setter((previous) => (Math.abs(previous - measured) > 2 ? Math.round(measured) : previous));
  };
  const handleHandleLayout = useCallback((event: LayoutChangeEvent) => {
    setHeightIfChanged(setHandleHeight, event.nativeEvent.layout.height);
  }, []);
  const handleAboveFoldLayout = useCallback((event: LayoutChangeEvent) => {
    setHeightIfChanged(setAboveFoldHeight, event.nativeEvent.layout.height);
  }, []);

  const peekHeight =
    handleHeight > 0 && aboveFoldHeight > 0
      ? handleHeight + spacing[2] + aboveFoldHeight + insets.bottom + spacing[3]
      : 0;

  useEffect(() => {
    if (peekHeight === 0) return;
    sheetRef.current?.snapToIndex(indexRef.current);
  }, [peekHeight]);

  const handleChange = useCallback((index: number) => {
    indexRef.current = index;
  }, []);

  const snapPoints = useMemo<(number | string)[]>(
    () => (peekHeight > 0 ? [peekHeight, '100%'] : ['80%', '100%']),
    [peekHeight],
  );

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.4} pressBehavior="close" />
    ),
    [],
  );

  const HandleComponent = useMemo(
    () => (props: BottomSheetHandleProps) => (
      <View onLayout={handleHandleLayout}>
        <BottomSheetHandle {...props} indicatorStyle={sheetStyles.indicator} />
      </View>
    ),
    [handleHandleLayout],
  );

  const backgroundStyle = { ...sheetStyles.background, backgroundColor: systemColors.secondaryBackground };

  return (
    <BottomSheet
      ref={sheetRef}
      index={0}
      snapPoints={snapPoints}
      topInset={insets.top}
      enablePanDownToClose
      enableContentPanningGesture={!subSheetOpen}
      enableHandlePanningGesture={!subSheetOpen}
      backdropComponent={renderBackdrop}
      handleComponent={HandleComponent}
      backgroundStyle={backgroundStyle}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
      onChange={handleChange}
      onClose={onClose}
    >
      <BottomSheetScrollView
        style={styles.scroll}
        contentContainerStyle={{ paddingTop: spacing[2], paddingBottom: insets.bottom + spacing[4] }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <View onLayout={handleAboveFoldLayout}>
          <CreateDrawerHeader
            name={controller.name}
            onChangeName={controller.setName}
            startingCount={controller.startingCount}
            finishCount={controller.finishCount}
            focusSignal={controller.focusNameSignal}
            onClose={() => sheetRef.current?.close()}
            bleConnected={controller.bleConnected}
            bleConnecting={controller.bleConnecting}
            onToggleBle={controller.handleToggleBle}
          />

          {controller.publishDuplicateError ? (
            <DuplicateBanner
              name={controller.publishDuplicateError.existingClimbName}
              onView={
                controller.publishDuplicateError.existingClimbUuid
                  ? () => {
                      const uuid = controller.publishDuplicateError?.existingClimbUuid;
                      if (uuid) onViewDuplicate(uuid);
                    }
                  : undefined
              }
              onDismiss={controller.dismissDuplicateError}
            />
          ) : null}

          <View style={styles.boardSection}>
            <InteractiveCreateBoard
              background={background}
              boardWidth={boardHolds.boardWidth}
              boardHeight={boardHolds.boardHeight}
              holdTargets={boardHolds.holdTargets}
              litUpHoldsMap={controller.litUpHoldsMap}
              onPaint={controller.handlePaint}
              onLongPressHold={onLongPressHold}
              showAllHolds={controller.showAllHolds}
              renderWidth={boardRender.width}
              renderHeight={boardRender.height}
              overlay={overlay}
            />
          </View>

          <CreateDrawerActionBar
            boardName={board.boardName}
            selectedBrush={controller.selectedBrush}
            onSelectBrush={controller.setSelectedBrush}
            paintRoles={paintRoles}
            canUndo={controller.canUndo}
            canRedo={controller.canRedo}
            onUndo={controller.undo}
            onRedo={controller.redo}
            onClear={controller.handleClear}
            onToggleHeatmap={onToggleHeatmap}
            heatmapActive={heatmapActive}
            canSetActive={controller.canSetActive}
            onSetActive={controller.handleSetActive}
            saveState={controller.saveState}
            onSave={() => void controller.handleSave()}
          />
        </View>

        <View style={styles.belowFold}>{belowFold}</View>
      </BottomSheetScrollView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  boardSection: {
    marginHorizontal: spacing[4],
    marginTop: spacing[2],
  },
  belowFold: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[4],
    gap: spacing[4],
  },
});
