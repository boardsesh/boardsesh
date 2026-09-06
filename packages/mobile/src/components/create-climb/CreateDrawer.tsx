import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
  type ComponentType,
  type RefObject,
} from 'react';
import { View, StyleSheet, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { GestureHandlerRootView, ScrollView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useWindowBottomInset } from '../../hooks/use-window-bottom-inset';
// Migrated off @gorhom/bottom-sheet to Expo's native bottom sheet (#3167). The
// native sheet draws its own scrim + drag handle, so the measured-handle peek
// machinery is replaced by a small fixed reserve for the native grabber.
//
// The scroll container is RNGH's own `ScrollView`, NOT `@expo/ui`'s
// `BottomSheetScrollView` (a bare re-export of React Native's plain
// `ScrollView`). A plain ScrollView can't be declared a relation with an RNGH
// gesture — Android's classic `ScrollView.onInterceptTouchEvent` can win the
// touch stream on the very first vertical-ish move, before InteractiveCreateBoard's
// pinch has a chance to activate and call `requestDisallowInterceptTouchEvent`.
// That raced exactly like the board's per-hold-detector-vs-pinch race the
// pinchRef fix (#4425/#3045) already solved, just one level further out: a
// pinch with any vertical component got cancelled by the scroll, so only a
// carefully horizontal-only pinch survived (issue #5107). Swapping in RNGH's
// ScrollView + `scrollRef` lets useZoomPanGesture declare the same relation
// PlayDrawer already uses for its own surrounding scroll — pinch simultaneous
// with the scroll (never cancelled), zoomed-pan blocks the scroll (drags the
// board, not the sheet) — eliminating the race instead of reacting to it.
import BottomSheet from '@expo/ui/community/bottom-sheet';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import { useTheme } from '../../providers/theme-provider';
import { spacing, sheetStyles } from '../../theme/tokens';
import type { BoardHoldTarget } from '../../lib/create-board-holds';
import { InteractiveCreateBoard, type CreateBoardControls } from './InteractiveCreateBoard';
import { CreateDrawerHeader } from './CreateDrawerHeader';
import { CreateDrawerActionBar } from './CreateDrawerActionBar';
import { CreateDrawerForm } from './CreateDrawerForm';
import { CreateRoutePlaybackSlot } from './CreateRoutePlaybackSlot';
import type { CreateOverflowAction } from './create-overflow-menu';
import { computeBoardMaxHeight } from './create-drawer-layout';
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

// The peek must never grow into the '100%' snap — at that point the two snap
// points collapse into one, the sheet has no travel and the "drag up for the
// form" affordance is dead. Belt and braces for a large Dynamic Type setting or
// a locale with taller chrome.
const MAX_PEEK_FRACTION = 0.92;

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
  // A SEPARATE hook, not `useTranslation(['climbs', 'session'])`: with an array,
  // `t('a.b.c')` resolves against the FIRST namespace only, so the wall-state
  // key — which lives in session.json — fell through and the chip rendered the
  // raw `playView.wallState.onWall`. Every CreateDrawer suite mocks `t` as
  // identity, so nothing caught it until the emulator did. Matches
  // CreateDrawerHeader, which already aliases its second and third namespaces.
  const { t: tSession } = useTranslation('session');
  const insets = useSafeAreaInsets();
  // Bottom terms use the WINDOW inset: this drawer is a route inside the climbs
  // tab, whose per-tab provider folds iOS 26 tab chrome the sheet covers into
  // insets.bottom (see use-window-bottom-inset). insets.top stays local.
  const windowInsetBottom = useWindowBottomInset();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const sheetRef = useRef<BottomSheet>(null);
  // The outer RNGH ScrollView, so the board's pinch/zoomed-pan can declare a
  // relation with it (see the import comment above). Typed as RNGH's
  // GestureRef shape so useZoomPanGesture/InteractiveCreateBoard need no cast
  // at the call site — mirrors PlayDrawer's scrollGestureRef.
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const scrollGestureRef = scrollRef as unknown as RefObject<ComponentType | undefined | null>;
  // True while InteractiveCreateBoard is zoomed or mid-pinch. The sheet's own
  // pan/drag gesture is a native Compose gesture (Android) / SwiftUI gesture
  // (iOS), not RNGH — nothing in the board's gesture tree can block it, so it
  // competes directly with the board's pinch/pan and can win, sliding the
  // sheet instead of zooming/panning the board. Disabled for the duration via
  // enablePanDownToClose below, the same way subSheetOpen already does for the
  // role-picker sub-sheet.
  const [boardInteractionActive, setBoardInteractionActive] = useState(false);

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

  // The board owns the zoom AND renders the reset control; the drawer only
  // holds a handle so it can drop the zoom when the frame or the climb changes
  // underneath it.
  const boardControlsRef = useRef<CreateBoardControls | null>(null);
  const resetBoardZoom = useCallback(() => {
    boardControlsRef.current?.resetZoom();
  }, []);

  // Zoom is a view of ONE frame. Carrying it across a frame change leaves you
  // staring at a magnified corner of a climb you didn't ask for, so drop it —
  // the play drawer already does exactly this (SwipeBoardCarousel, PlayDrawer).
  //
  // Keyed on the count as well as the index, because deleting a frame can swap
  // the frame under you WITHOUT moving the index: DELETE_FRAME clamps, so
  // removing the middle of three leaves the index at 1 pointing at what used to
  // be frame 2. The index alone would miss it and keep the old frame's zoom.
  useEffect(() => {
    resetBoardZoom();
  }, [controller.currentFrameIndex, controller.frameCount, resetBoardZoom]);

  // Same reasoning for swapping the climb entirely: a fresh editor or a loaded
  // draft should open at 1x, not inherit the last climb's zoom.
  //
  // Keyed on the epoch, not on the New Climb press: with unsaved work that press
  // only raises the confirmation banner, and cancelling it leaves you on the
  // same climb — having silently lost your zoom. The controller bumps the epoch
  // only once a blank climb has actually started, on either path.
  useEffect(() => {
    resetBoardZoom();
  }, [controller.blankClimbEpoch, resetBoardZoom]);

  const handleLoadDraft = useCallback(
    (climb: Climb) => {
      resetBoardZoom();
      onLoadDraft(climb);
    },
    [resetBoardZoom, onLoadDraft],
  );

  const overflowState = useMemo(
    () => ({
      supportsMultiFrame: controller.supportsMultiFrame,
      routeMode: controller.routeMode,
      frameCount: controller.frameCount,
      frameIndex: controller.currentFrameIndex,
    }),
    [controller.supportsMultiFrame, controller.routeMode, controller.frameCount, controller.currentFrameIndex],
  );

  const handleOverflowAction = useCallback(
    (action: CreateOverflowAction) => {
      switch (action) {
        case 'makeRoute':
          controller.enterRouteMode();
          return;
        case 'makeBoulder':
          controller.leaveRouteMode();
          return;
        case 'newClimb':
          controller.handleNewClimb();
      }
    },
    [controller],
  );

  // A boulder pays nothing for route chrome now that route mode is opt-in from
  // the header's overflow menu — #4761 charged every climb 52dp for a strip
  // pitching a feature most setters never use. Woods, which can only ever hold
  // one frame, likewise.
  const boardMaxHeight = computeBoardMaxHeight({
    windowHeight,
    insetTop: insets.top,
    insetBottom: windowInsetBottom,
    showRouteTransport: controller.showRouteTransport,
  });

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
  const maxPeek = Math.round((windowHeight - insets.top) * MAX_PEEK_FRACTION);
  const peekHeight =
    aboveFoldHeight > 0
      ? Math.min(NATIVE_HANDLE_RESERVE + spacing[2] + aboveFoldHeight + windowInsetBottom + spacing[3], maxPeek)
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

  const backgroundStyle = { ...sheetStyles.background, backgroundColor: systemColors.secondaryBackground };

  return (
    <BottomSheet
      ref={sheetRef}
      index={0}
      snapPoints={snapPoints}
      // `enableContentPanningGesture`/`enableHandlePanningGesture` exist on
      // BottomSheetProps for gorhom API compatibility but are documented as
      // having no effect on native platforms — "Native sheets handle content
      // panning internally" (@expo/ui's own types.ts). `enablePanDownToClose`
      // is the one prop this library version actually wires up on both
      // platforms (Android: sheetGesturesEnabled = enablePanDownToClose;
      // iOS: interactiveDismissDisabled = !enablePanDownToClose) — it's the
      // real lever for disabling the sheet's own drag while a sub-sheet is
      // open or the board is zoomed/mid-pinch, at the cost of also disabling
      // pan-down-to-close (and, on Android, back-press/scrim-tap dismiss) for
      // the same duration, which is the right tradeoff: an accidental swipe
      // shouldn't discard the in-progress climb either.
      enablePanDownToClose={!subSheetOpen && !boardInteractionActive}
      backgroundStyle={backgroundStyle}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      onChange={handleChange}
      onClose={onClose}
    >
      <GestureHandlerRootView style={styles.scroll}>
        <ScrollView
          ref={scrollRef}
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
              overflow={overflowState}
              onSelectOverflowAction={handleOverflowAction}
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
                frames={controller.currentFramesString}
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
                controlRef={boardControlsRef}
                onInteractionActiveChange={setBoardInteractionActive}
                scrollRef={scrollGestureRef}
              />
            </View>

            <CreateRoutePlaybackSlot
              showRouteTransport={controller.showRouteTransport}
              frameCount={controller.frameCount}
              frameIndex={controller.currentFrameIndex}
              playback={controller.playback}
              wallStateLabel={controller.handedOff ? tSession('playView.wallState.onWall') : null}
              onAddFrame={controller.duplicateFrame}
              onDeleteFrame={controller.deleteFrame}
              onPaceChange={controller.setFramesPace}
            />

            <CreateDrawerActionBar
              boardName={board.boardName}
              selectedBrush={controller.selectedBrush}
              onSelectBrush={controller.setSelectedBrush}
              canUndo={controller.canUndo}
              canRedo={controller.canRedo}
              onUndo={controller.undo}
              onRedo={controller.redo}
              onClearHolds={controller.handleClearHolds}
              frameCount={controller.frameCount}
              currentFrameIndex={controller.currentFrameIndex}
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
            <OpenDraftsSection board={board} onLoadDraft={handleLoadDraft} />
          </View>
        </ScrollView>
      </GestureHandlerRootView>
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
