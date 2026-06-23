import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import BottomSheet, {
  BottomSheetScrollView,
  BottomSheetHandle,
  type BottomSheetBackdropProps,
  type BottomSheetHandleProps,
} from '@gorhom/bottom-sheet';
import { SheetBackdrop } from '../SheetBackdrop';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import { useTheme } from '../../providers/theme-provider';
import { spacing, sheetStyles } from '../../theme/tokens';
import type { BoardHoldTarget } from '../../lib/create-board-holds';
import { InteractiveCreateBoard } from './InteractiveCreateBoard';
import { CreateDrawerHeader } from './CreateDrawerHeader';
import { CreateDrawerActionBar } from './CreateDrawerActionBar';
import { CreateDrawerForm } from './CreateDrawerForm';
import { OpenDraftsSection } from './OpenDraftsSection';
import { DuplicateBanner } from './DuplicateBanner';
import { useCreateClimbScreen, type CreateClimbBoard } from './use-create-climb-screen';

type Controller = ReturnType<typeof useCreateClimbScreen>;

type BoardHolds = {
  holdTargets: BoardHoldTarget[];
  boardWidth: number;
  boardHeight: number;
};

type CreateDrawerProps = {
  board: CreateClimbBoard;
  controller: Controller;
  boardHolds: BoardHolds;
  onLongPressHold: (holdId: number) => void;
  /** True while a stacked sub-sheet (e.g. the long-press role picker) is open —
   *  disables the drawer's pan so a drag over the sub-sheet doesn't move it. */
  subSheetOpen: boolean;
  onLoadDraft: (climb: Climb) => void;
  /** Dismiss the create drawer (the header's close chevron). */
  onClose: () => void;
  /** Open the climb that a publish collided with (the duplicate banner link). */
  onViewDuplicate: (uuid: string) => void;
};

// Space the header + two-row action bar + handle + safe areas need, so the
// board is sized to leave them on-screen at the peek (a rough reserve — the
// peek snap itself is measured from the real above-fold height).
const ABOVE_FOLD_CHROME = 300;

/**
 * The create-climb drawer — one Play Drawer-style bottom sheet. Peek shows the
 * header (editable name + start/finish), the board, and the two-row action bar
 * (brush chips + actions). Dragging up reveals the below-the-fold form
 * (description, toggles, connect) and the Open Drafts table.
 */
export function CreateDrawer({
  board,
  controller,
  boardHolds,
  onLongPressHold,
  subSheetOpen,
  onLoadDraft,
  onClose,
  onViewDuplicate,
}: CreateDrawerProps) {
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const sheetRef = useRef<BottomSheet>(null);

  // Measured contributors to the peek snap-point — same runtime-measurement
  // approach as the Play Drawer rather than hardcoded heights.
  const [handleHeight, setHandleHeight] = useState(0);
  const [aboveFoldHeight, setAboveFoldHeight] = useState(0);
  // Live snap index, kept current via onChange so the re-snap below targets the
  // index the user is actually at (not a one-shot reset that breaks on rotation).
  const indexRef = useRef(0);

  const boardMaxHeight = Math.max(200, windowHeight - insets.top - insets.bottom - ABOVE_FOLD_CHROME);

  // Compute the on-screen board size up front (window width minus the board
  // section margins, capped by the height budget) so the board paints on the
  // first frame instead of waiting for an onLayout pass inside the animating sheet.
  const boardRender = useMemo(() => {
    const boardAspect = boardHolds.boardWidth / boardHolds.boardHeight;
    const availWidth = windowWidth - spacing[4] * 2;
    const availAspect = availWidth / boardMaxHeight;
    if (availAspect > boardAspect) {
      return { width: boardMaxHeight * boardAspect, height: boardMaxHeight };
    }
    return { width: availWidth, height: availWidth / boardAspect };
  }, [boardHolds.boardWidth, boardHolds.boardHeight, windowWidth, boardMaxHeight]);

  const setHeightIfChanged = (setter: (updater: (prev: number) => number) => void, measured: number) => {
    setter((prev) => (Math.abs(prev - measured) > 2 ? Math.round(measured) : prev));
  };
  const handleHandleLayout = useCallback((event: LayoutChangeEvent) => {
    setHeightIfChanged(setHandleHeight, event.nativeEvent.layout.height);
  }, []);
  const handleAboveFoldLayout = useCallback((event: LayoutChangeEvent) => {
    setHeightIfChanged(setAboveFoldHeight, event.nativeEvent.layout.height);
  }, []);

  // handle + content paddingTop + above-fold (header + board + action bar) +
  // bottom safe area + a reveal margin so a hint of the below-fold form peeks.
  const peekHeight =
    handleHeight > 0 && aboveFoldHeight > 0
      ? handleHeight + spacing[2] + aboveFoldHeight + insets.bottom + spacing[3]
      : 0;

  // Re-snap to the current index whenever the peek height changes: the first
  // measurement (fallback → measured peek) and any re-layout (rotation resizes
  // the board, so peekHeight changes) settle the sheet to the right height
  // without yanking a user who has expanded it.
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

  // Dim the scene behind at every snap. Tapping the backdrop or swiping down
  // dismisses the drawer (autosave keeps any in-progress draft).
  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <SheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.4} pressBehavior="close" />
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
              boardName={board.boardName as BoardName}
              layoutId={board.layoutId}
              sizeId={board.sizeId}
              setIds={board.setIds}
              boardWidth={boardHolds.boardWidth}
              boardHeight={boardHolds.boardHeight}
              holdTargets={boardHolds.holdTargets}
              litUpHoldsMap={controller.litUpHoldsMap}
              onPaint={controller.handlePaint}
              onLongPressHold={onLongPressHold}
              showAllHolds={controller.showAllHolds}
              renderWidth={boardRender.width}
              renderHeight={boardRender.height}
            />
          </View>

          <CreateDrawerActionBar
            boardName={board.boardName}
            selectedBrush={controller.selectedBrush}
            onSelectBrush={controller.setSelectedBrush}
            canUndo={controller.canUndo}
            canRedo={controller.canRedo}
            onUndo={controller.undo}
            onRedo={controller.redo}
            onClear={controller.handleClear}
            canSetActive={controller.canSetActive}
            onSetActive={controller.handleSetActive}
            saveState={controller.saveState}
            onSave={() => void controller.handleSave()}
          />
        </View>

        <View style={styles.belowFold}>
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
          <OpenDraftsSection board={board} onLoadDraft={onLoadDraft} />
        </View>
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
