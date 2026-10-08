import type { WindowAnchorPoint } from '../navigation/AnchoredPopover.types';
import { PublicationAudiencePicker } from '../privacy/PublicationAudiencePicker';
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
import { Platform, View, StyleSheet, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { GestureHandlerRootView, ScrollView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useWindowBottomInset } from '../../hooks/use-window-bottom-inset';
import { useKeyboardHeight } from '../../hooks/use-keyboard-height';
// The scroll container is RNGH's own `ScrollView`, not React Native's plain one.
// A plain ScrollView can't be declared a relation with an RNGH gesture, and on
// Android its classic `onInterceptTouchEvent` can win the touch stream on the
// very first vertical-ish move, before InteractiveCreateBoard's pinch activates
// (issue #5107). With RNGH's ScrollView + `scrollRef`, useZoomPanGesture
// declares the pinch simultaneous with the scroll and makes a zoomed pan block
// it, the same relation PlayDrawer uses for its own surrounding scroll.
import type { BoardName, Climb, HoldStat } from '@boardsesh/shared-schema';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import type { BoardHoldTarget } from '../../lib/create-board-holds';
import { AccessibleHoldList } from './AccessibleHoldList';
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
import { NameRequiredHint } from './NameRequiredHint';
import { LostHoldGhostLayer } from './LostHoldGhostLayer';
import type { LostHoldGhostsState } from './use-lost-hold-ghosts';
import { useTranslation } from 'react-i18next';
import { useCreateClimbScreen, type CreateClimbBoard } from './use-create-climb-screen';
import { HeatmapOverlay, useHeatLayer } from '../board/HeatmapOverlay';
import { formatHeatmapClimbCount, HeatmapLegend } from '../board/HeatmapLegend';
import { HeatmapDownloadLine } from '../board/HeatmapDownloadLine';
import { Text } from '../Text';
import type { CreateHeatmap } from './create-heatmap';
import { offersBoardLightbulb } from './spray-climb-rules';

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
  onLongPressHold: (holdId: number, anchor?: WindowAnchorPoint) => void;
  onLoadDraft: (climb: Climb) => void;
  /** Leave the editor (the header's X). The draft is kept. */
  onClose: () => void;
  /** Open the climb that a publish collided with (the duplicate banner link). */
  onViewDuplicate: (uuid: string) => void;
  /** The hold heatmap, following the active brush (omitted → no heatmap button). */
  heatmap?: CreateHeatmap;
  /** Grey rings where a remixed climb's lost holds were. Save waits until they are gone. */
  lostHolds?: LostHoldGhostsState;
};

const NO_STATS: ReadonlyMap<number, HoldStat> = new Map<number, HoldStat>();

/**
 * The create-climb editor: the body of the New climb route, a full-height modal
 * task (a pageSheet on iOS, a full-screen dialog on Android). The top bar (X,
 * editable name + start/finish, the overflow menu and Save) is pinned above the
 * scroll; the board, the tool rows, the form (description, toggles) and the
 * Open Drafts table scroll under it.
 */
export function CreateDrawer({
  board,
  controller,
  boardHolds,
  onLongPressHold,
  onLoadDraft,
  onClose,
  onViewDuplicate,
  heatmap,
  lostHolds,
}: CreateDrawerProps) {
  const { systemColors } = useTheme();
  const [holdListVisible, setHoldListVisible] = useState(false);
  const { t, i18n } = useTranslation('climbs');
  // A SEPARATE hook, not `useTranslation(['climbs', 'session'])`: with an array,
  // `t('a.b.c')` resolves against the FIRST namespace only, so the wall-state
  // key — which lives in session.json — fell through and the chip rendered the
  // raw `playView.wallState.onWall`. Every CreateDrawer suite mocks `t` as
  // identity, so nothing caught it until the emulator did. Matches
  // CreateDrawerHeader, which already aliases its second and third namespaces.
  const { t: tSession } = useTranslation('session');
  const insets = useSafeAreaInsets();
  // Bottom terms use the WINDOW inset: this route sits inside the climbs tab,
  // whose per-tab provider folds iOS 26 tab chrome the modal covers into
  // insets.bottom (see use-window-bottom-inset).
  const windowInsetBottom = useWindowBottomInset();
  // Native iOS editing cards start below the status bar; Android's full-screen
  // dialog needs the status-bar inset.
  const topInset = Platform.OS === 'ios' ? 0 : insets.top;
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [hostSize, setHostSize] = useState<{ width: number; height: number } | null>(null);
  const measureHost = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (width <= 0 || height <= 0) return;
    setHostSize((previous) => (previous?.width === width && previous.height === height ? previous : { width, height }));
  }, []);
  const editorWidth = hostSize?.width ?? windowWidth;
  const editorHeight = hostSize?.height ?? windowHeight;
  // The outer RNGH ScrollView, so the board's pinch/zoomed-pan can declare a
  // relation with it (see the import comment above). Typed as RNGH's
  // GestureRef shape so useZoomPanGesture/InteractiveCreateBoard need no cast
  // at the call site — mirrors PlayDrawer's scrollGestureRef.
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const scrollGestureRef = scrollRef as unknown as RefObject<ComponentType | undefined | null>;
  // Android never shrinks this route for the keyboard: the app is edge-to-edge
  // (decorFitsSystemWindows false), so adjustResize does nothing and the IME
  // draws over the scroll. Pad the scroll by the keyboard so the description
  // can be scrolled clear of it. RN reports the IME inset MINUS the nav bar,
  // and the pad below already carries the window inset, so the two add up to
  // the IME's full height with no double count. iOS does this natively
  // (automaticallyAdjustKeyboardInsets below), so it takes no pad.
  const keyboardPad = useKeyboardHeight(Platform.OS === 'android');

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
      holdListVisible,
    }),
    // Deliberately NOT currentFrameIndex: the menu stopped reading it when the
    // frame commands moved to the transport card, and CreateDrawerHeader is
    // memo'd — keeping it here handed the header a new object on every playback
    // tick, as often as twice a second.
    [controller.supportsMultiFrame, controller.routeMode, controller.frameCount, holdListVisible],
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
        case 'toggleHoldList':
          setHoldListVisible((visible) => !visible);
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
    windowHeight: editorHeight,
    insetTop: insets.top,
    insetBottom: windowInsetBottom,
    showRouteTransport: controller.showRouteTransport,
  });

  // Fit the board to the measured editing card. Window dimensions seed the
  // first frame; a narrower iPad card then resizes without clipping.
  const boardRender = useMemo(() => {
    const boardAspect = boardHolds.boardWidth / boardHolds.boardHeight;
    const availWidth = editorWidth - spacing[4] * 2;
    const availAspect = availWidth / boardMaxHeight;
    if (availAspect > boardAspect) {
      return { width: boardMaxHeight * boardAspect, height: boardMaxHeight };
    }
    return { width: availWidth, height: availWidth / boardAspect };
  }, [boardHolds.boardWidth, boardHolds.boardHeight, editorWidth, boardMaxHeight]);

  // Heat covers every hold, painted ones included: the painted hold's own mark
  // is drawn in the holds layer on top and covers it. Skipping painted holds in
  // the heat frames changed the heat picture on every tap, i.e. a fresh native
  // render and a new PNG per paint state. This way the heat image only changes
  // with the brush, the data or the scheme.
  const heatmapActive = heatmap?.active ?? false;
  const heatLayer = useHeatLayer({
    statsByHoldId: heatmap?.statsByHoldId ?? NO_STATS,
    holdTargets: boardHolds.holdTargets,
    metric: heatmapActive && heatmap?.status === 'ready' ? (heatmap.metric ?? null) : null,
  });
  const heatmapOverlay = useMemo(
    () =>
      heatmapActive ? (
        <HeatmapOverlay
          layer={heatLayer}
          boardName={board.boardName as BoardName}
          layoutId={board.layoutId}
          sizeId={board.sizeId}
          setIds={board.setIds}
          holdTargets={boardHolds.holdTargets}
          boardWidth={boardHolds.boardWidth}
          boardHeight={boardHolds.boardHeight}
        />
      ) : null,
    [heatmapActive, heatLayer, board.boardName, board.layoutId, board.sizeId, board.setIds, boardHolds],
  );
  // Grey rings where a remixed climb's lost holds were, drawn over the heat.
  const lostHoldGhosts = lostHolds?.ghosts;
  const boardOverlay = useMemo(() => {
    if (!lostHoldGhosts || lostHoldGhosts.length === 0) return heatmapOverlay;
    return (
      <>
        {heatmapOverlay}
        <LostHoldGhostLayer
          ghosts={lostHoldGhosts}
          boardWidth={boardHolds.boardWidth}
          boardHeight={boardHolds.boardHeight}
          renderWidth={boardRender.width}
          renderHeight={boardRender.height}
        />
      </>
    );
  }, [
    heatmapOverlay,
    lostHoldGhosts,
    boardHolds.boardWidth,
    boardHolds.boardHeight,
    boardRender.width,
    boardRender.height,
  ]);
  const ghostsPending = lostHoldGhosts != null && lostHoldGhosts.length > 0;
  // Save in the header is live only once the holds can be stored: any hold for
  // a draft, a start and a finish for a publish, and no lost-hold rings up.
  // handleSave refuses the same cases, so this only makes the refusal visible.
  const climbReady = (controller.isDraft ? controller.canSave : controller.canPublish) && !ghostsPending;
  const { handleSave, bleConnected, bleConnecting, handleToggleBle } = controller;
  const showLightbulb = offersBoardLightbulb(board.boardName);
  const lightbulb = useMemo(
    () =>
      showLightbulb ? { connected: bleConnected, connecting: bleConnecting, onToggle: handleToggleBle } : undefined,
    [showLightbulb, bleConnected, bleConnecting, handleToggleBle],
  );
  const handleSavePress = useCallback(() => {
    void handleSave();
  }, [handleSave]);
  const ghostCount = lostHoldGhosts?.length ?? 0;
  const saveBlockedLine = useMemo(
    () =>
      ghostCount > 0 ? (
        <Text variant="caption1" color={systemColors.secondaryLabel} numberOfLines={1}>
          {t('mobile.lostHolds.editorHint', { count: ghostCount })}
        </Text>
      ) : null,
    [ghostCount, systemColors.secondaryLabel, t],
  );

  // While heat is on, the status line under the tools explains it (or offers the download)
  // in place of the autosave note. Erase hides the heat, and the line with it.
  const heatmapLine = useMemo(() => {
    if (!heatmap?.active) return null;
    if (heatmap.status === 'download') {
      return <HeatmapDownloadLine board={heatmap.downloadBoard} numberOfLines={1} testID="create-heatmap-download" />;
    }
    if (heatmap.status === 'error') {
      return (
        <Text variant="caption1" color={systemColors.secondaryLabel} numberOfLines={1}>
          {t('mobile.heatmap.loadFailed')}
        </Text>
      );
    }
    if (heatmap.status === 'unavailable') {
      return (
        <Text variant="caption1" color={systemColors.secondaryLabel} numberOfLines={1}>
          {t('mobile.heatmap.unavailable')}
        </Text>
      );
    }
    if (heatmap.metric === null) return null;
    const count = heatmap.climbCount;
    return (
      <HeatmapLegend
        legend={heatLayer.legend}
        lowLabel={t('mobile.heatmap.legend.fewClimbs')}
        highLabel={t('mobile.heatmap.legend.manyClimbs')}
        allEqualLabel={t('mobile.heatmap.legend.allEqual')}
        scopeLabel={count === null ? null : formatHeatmapClimbCount(t, count, i18n?.language)}
        wrap={false}
        testID="create-heatmap-legend"
      />
    );
  }, [heatmap, heatLayer.legend, systemColors.secondaryLabel, t, i18n?.language]);

  return (
    <View
      onLayout={measureHost}
      style={[styles.root, { paddingTop: topInset, backgroundColor: systemColors.secondaryBackground }]}
    >
      {/* Pinned above the scroll, like every modal task's top bar: the X and
          Save never move with the content or the keyboard. */}
      <PublicationAudiencePicker privacy={controller.privacy} />
      <CreateDrawerHeader
        name={controller.name}
        onChangeName={controller.setName}
        startingCount={controller.startingCount}
        finishCount={controller.finishCount}
        focusSignal={controller.focusNameSignal}
        onClose={onClose}
        overflow={overflowState}
        onSelectOverflowAction={handleOverflowAction}
        saveState={controller.saveState}
        onSave={handleSavePress}
        climbReady={climbReady}
      />
      <GestureHandlerRootView style={styles.scroll}>
        {holdListVisible ? (
          <AccessibleHoldList
            holds={boardHolds.holdTargets}
            roles={controller.litUpHoldsMap}
            onPaint={controller.handlePaint}
            onChooseRole={onLongPressHold}
          />
        ) : (
          <ScrollView
            ref={scrollRef}
            style={styles.scroll}
            contentContainerStyle={{ paddingBottom: windowInsetBottom + spacing[4] + keyboardPad }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            automaticallyAdjustKeyboardInsets
          >
            {/* Transient banners sit at the top of the scroll, under the pinned
            top bar, and push the board down rather than covering it. */}
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

            {controller.nameMissingHint ? <NameRequiredHint announceKey={controller.nameMissingTick} /> : null}

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

            <View testID="create-drawer-board-block">
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
                  renderWidth={boardRender.width}
                  renderHeight={boardRender.height}
                  controlRef={boardControlsRef}
                  scrollRef={scrollGestureRef}
                  overlay={boardOverlay}
                  ghostTargets={lostHolds?.ghostTargets}
                  onGhostPress={lostHolds?.dismissGhost}
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
                frameDeletions={controller.frameDeletions}
                currentFrameIndex={controller.currentFrameIndex}
                canSetActive={controller.canSetActive}
                onSetActive={controller.handleSetActive}
                lightbulb={lightbulb}
                draftStatus={controller.draftStatus}
                onToggleHeatmap={heatmap?.toggle}
                heatmapActive={heatmapActive}
                heatmapBusy={heatmap?.busy ?? false}
                heatmapLine={heatmapLine}
                saveBlockedLine={saveBlockedLine}
              />
            </View>

            <View style={styles.belowFold}>
              <CreateDrawerForm
                boardName={board.boardName}
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
              />
              <OpenDraftsSection board={board} onLoadDraft={handleLoadDraft} />
            </View>
          </ScrollView>
        )}
      </GestureHandlerRootView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
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
