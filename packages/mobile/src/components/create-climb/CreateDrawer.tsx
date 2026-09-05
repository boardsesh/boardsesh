import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useWindowBottomInset } from '../../hooks/use-window-bottom-inset';
// Migrated off @gorhom/bottom-sheet to Expo's native bottom sheet (#3167). The
// native sheet draws its own scrim + drag handle, so the measured-handle peek
// machinery is replaced by a small fixed reserve for the native grabber.
import BottomSheet, { BottomSheetScrollView } from '@expo/ui/community/bottom-sheet';
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
import { InlineConfirmBanner } from './InlineConfirmBanner';
import { useTranslation } from 'react-i18next';
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

// Space the header + action bar + draft-status line + handle + safe areas need,
// so the board is sized to leave them on-screen at the peek (a rough reserve —
// the peek snap itself is measured from the real above-fold height, so erring
// high only costs a few dp of board).
//
// Raised from 300 by exactly what the status line costs the action bar: +32 for
// its line box and padding, −8 from the action row's bottom padding, so +24. The
// board shrinks by the same 24, which makes the peek height IDENTICAL to what it
// was before the line existed — the status line is free at the peek, in every
// state (the row reserves its height even when empty, so this doesn't drift as
// you paint). Deliberately not rounded: a round number here would silently make
// the peek taller and eat into an already-tight budget on a tall board.
const ABOVE_FOLD_CHROME = 324;

// The native sheet's drag grabber sits in the sheet chrome above the content;
// reserve a small fixed amount for it in the peek snap-point (replaces the old
// runtime-measured gorhom handle height).
const NATIVE_HANDLE_RESERVE = spacing[6];

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
  const { t } = useTranslation('climbs');
  const insets = useSafeAreaInsets();
  // Bottom terms use the WINDOW inset: this drawer is a route inside the climbs
  // tab, whose per-tab provider folds iOS 26 tab chrome the sheet covers into
  // insets.bottom (see use-window-bottom-inset). insets.top stays local.
  const windowInsetBottom = useWindowBottomInset();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const sheetRef = useRef<BottomSheet>(null);

  // Measured above-fold height drives the peek snap-point (the native grabber is
  // a fixed reserve now, not a measured custom handle).
  // Measured in two pieces, with the transient banners sitting BETWEEN them and
  // measured by neither — see the note on the JSX below.
  const [headerHeight, setHeaderHeight] = useState(0);
  const [boardBlockHeight, setBoardBlockHeight] = useState(0);
  const aboveFoldHeight = headerHeight > 0 && boardBlockHeight > 0 ? headerHeight + boardBlockHeight : 0;
  // Live snap index, kept current via onChange so the re-snap below targets the
  // index the user is actually at (not a one-shot reset that breaks on rotation).
  const indexRef = useRef(0);

  const boardMaxHeight = Math.max(200, windowHeight - insets.top - windowInsetBottom - ABOVE_FOLD_CHROME);

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
  const handleHeaderLayout = useCallback((event: LayoutChangeEvent) => {
    setHeightIfChanged(setHeaderHeight, event.nativeEvent.layout.height);
  }, []);
  const handleBoardBlockLayout = useCallback((event: LayoutChangeEvent) => {
    setHeightIfChanged(setBoardBlockHeight, event.nativeEvent.layout.height);
  }, []);

  // native grabber reserve + content paddingTop + above-fold (header + board +
  // action bar) + bottom safe area + a reveal margin so a hint of the below-fold
  // form peeks.
  const peekHeight =
    aboveFoldHeight > 0 ? NATIVE_HANDLE_RESERVE + spacing[2] + aboveFoldHeight + windowInsetBottom + spacing[3] : 0;

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

  const backgroundStyle = { ...sheetStyles.background, backgroundColor: systemColors.secondaryBackground };

  return (
    <BottomSheet
      ref={sheetRef}
      index={0}
      snapPoints={snapPoints}
      enablePanDownToClose
      enableContentPanningGesture={!subSheetOpen}
      enableHandlePanningGesture={!subSheetOpen}
      backgroundStyle={backgroundStyle}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      onChange={handleChange}
      onClose={onClose}
    >
      <BottomSheetScrollView
        style={styles.scroll}
        contentContainerStyle={{ paddingTop: spacing[2], paddingBottom: windowInsetBottom + spacing[4] }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <View onLayout={handleHeaderLayout} testID="create-drawer-measured-header">
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
        </View>

        {/* Transient, and deliberately measured by NEITHER block above or below.
            The peek snap-point is derived from the measured above-fold height, so
            anything that mounts inside a measured region moves `peekHeight` and
            re-snaps the sheet — which collapsed an expanded drawer the instant a
            banner appeared, hiding the very climb the banner is asking about. The
            status row solved the same problem by reserving a constant line box;
            these can't, because reserving ~100dp permanently for something rarely
            on screen would cost more above-fold budget than the board can spare.
            So they push content instead of resizing the sheet: the drawer stays
            exactly where the climber put it. Pinned by "keeps the transient
            banners out of the measured above-fold region" in
            create-drawer-measured-region.test.tsx. */}
        {controller.pendingNewClimb ? (
          <InlineConfirmBanner
            title={t('mobile.create.newClimb.confirm.title')}
            message={t('mobile.create.newClimb.confirm.message')}
            confirmLabel={t('mobile.create.newClimb.confirm.action')}
            cancelLabel={t('createClimbForm.dismiss')}
            onConfirm={controller.confirmNewClimb}
            onCancel={controller.cancelNewClimb}
          />
        ) : null}

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

        <View onLayout={handleBoardBlockLayout} testID="create-drawer-measured-board-block">
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
            onClearHolds={controller.handleClearHolds}
            onNewClimb={controller.handleNewClimb}
            supportsMultiFrame={controller.supportsMultiFrame}
            frameCount={controller.frameCount}
            currentFrameIndex={controller.currentFrameIndex}
            onDuplicateFrame={controller.duplicateFrame}
            onDeleteFrame={controller.deleteFrame}
            onPrevFrame={controller.prevFrame}
            onNextFrame={controller.nextFrame}
            canSetActive={controller.canSetActive}
            onSetActive={controller.handleSetActive}
            saveState={controller.saveState}
            onSave={() => void controller.handleSave()}
            publishBlocked={controller.publishBlocked}
            draftStatus={controller.draftStatus}
          />
        </View>

        <View style={styles.belowFold}>
          <CreateDrawerForm
            description={controller.description}
            onChangeDescription={controller.setDescription}
            noMatch={controller.noMatch}
            onChangeNoMatch={controller.setNoMatch}
            noKickboard={controller.noKickboard}
            onChangeNoKickboard={controller.setNoKickboard}
            campus={controller.campus}
            onChangeCampus={controller.setCampus}
            anyFeet={controller.anyFeet}
            onChangeAnyFeet={controller.setAnyFeet}
            anyFeetAvailable={controller.anyFeetAvailable}
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
