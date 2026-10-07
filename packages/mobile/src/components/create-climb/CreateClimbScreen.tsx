import { useCallback, useMemo, useRef, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Button } from '../Button';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { openClimbInPlayDrawer } from '../../lib/open-climb-in-play-drawer';
import { getCreateBoardHolds } from '../../lib/create-board-holds';
import { getDifficultyIdForGradeName } from '../../lib/grade-label';
import { useSprayWall } from '../../lib/spray/use-spray-wall';
import { useSprayWallToken } from '../../lib/spray/use-spray-wall-token';
import { isSprayBoard, shouldAwaitWall } from './spray-climb-rules';
import { ActivityIndicator } from '../ActivityIndicator';
import { spacing } from '../../theme/tokens';
import { iosSystemColors } from '../../theme/ios-colors';
import { HoldRoleSheet } from './HoldRoleSheet';
import { LostHoldSheet } from './LostHoldSheet';
import { useLostHoldGhosts } from './use-lost-hold-ghosts';
import { getSprayWall, sprayWallViewerCanEdit } from '../../lib/spray/spray-wall-registry';
import {
  finishLostHoldPutBack,
  readLostHoldPutBackReturn,
  startLostHoldPutBack,
} from '../../lib/spray/lost-hold-put-back';
import { CreateDrawer } from './CreateDrawer';
import { useCreateClimbScreen, type CreateClimbBoard } from './use-create-climb-screen';
import { useHoldHeatmap } from '../../lib/graphql/hooks/use-hold-heatmap';
import { useCatalogQuerySourceState } from '../../lib/offline/use-catalog-query-source';
import { heatmapSearchInput } from '../search/heatmap/heatmap-search-input';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { heatMetricForBrush, type CreateHeatmap } from './create-heatmap';

type CreateClimbScreenProps = {
  board: CreateClimbBoard;
  forkFrames?: string;
  forkName?: string;
  forkDescription?: string;
  /** JSON-encoded `characteristics` of the climb being remixed (#4832). */
  forkCharacteristics?: string;
  /** The remixed climb's grade, as a name on the shared scale ("6c/V5"). */
  forkDifficulty?: string;
  /** The remixed climb's uuid, for drawing the holds it lost (#5493). */
  forkParentUuid?: string;
  editClimbUuid?: string;
  /** Set when the climber comes back from putting a lost hold back on the wall (#5493). */
  putBackRequest?: string;
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
  forkCharacteristics,
  forkDifficulty,
  forkParentUuid,
  editClimbUuid,
  putBackRequest,
}: CreateClimbScreenProps) {
  const { t } = useTranslation('climbs');
  const { t: tCommon } = useTranslation('common');
  const { systemColors } = useTheme();
  const router = useRouter();
  const { openPlayDrawer } = useDrawerHost();

  const handleStartedNewClimb = useCallback(() => {
    router.replace({
      pathname: '/(tabs)/climbs/create',
      params: {
        boardName: board.boardName,
        layoutId: String(board.layoutId),
        sizeId: String(board.sizeId),
        setIds: board.setIds,
        angle: String(board.angle),
      },
    });
  }, [router, board]);

  // A spray wall's holds are runtime data, not a bundled table: on a cold open
  // (a share link, a fork of somebody else's wall climb) the registry has nothing
  // yet, `getCreateBoardHolds` answers null, and without this the editor would
  // settle on "can't set climbs here" and never look again.
  //
  // The TOKEN, not the load state, is what everything downstream keys on: a
  // revalidation that brings a new wall version keeps reporting `ready`, so the
  // state alone would leave the editor painting the generation that just came off
  // the wall — and autosaving into the slot that generation owned.
  const sprayWallToken = useSprayWallToken(board.boardName, board.layoutId);
  const sprayLayoutId = isSprayBoard(board.boardName) ? board.layoutId : null;
  const { isLoading: sprayWallLoading } = useSprayWall(sprayLayoutId);

  // Back from the hold editor: the working copy left behind and the hold that
  // went back on. Read once; the request is cleared once it has been applied.
  const [putBackReturn] = useState(() => readLostHoldPutBackReturn(putBackRequest));
  // Set below once the ghost layer exists; the controller only calls this from an
  // effect, after the first render has assigned it.
  const flagPutBackRoleFullRef = useRef<() => void>(() => {});
  const handlePutBackApplied = useCallback(
    (roleFull: boolean) => {
      finishLostHoldPutBack(putBackRequest);
      // The hold is back on the wall but its role is full in the climb: say so
      // with the same line a refused pick gets, instead of leaving the ring up
      // with no word about why.
      if (roleFull) flagPutBackRoleFullRef.current();
    },
    [putBackRequest],
  );
  // The hold that went back on answers its ghost, wherever the owner nudged it.
  const [putBackInitialReplacements] = useState(() =>
    putBackReturn?.newHoldId != null ? new Map([[putBackReturn.lostHoldId, putBackReturn.newHoldId]]) : undefined,
  );

  const controller = useCreateClimbScreen({
    board,
    forkFrames,
    forkName,
    forkDescription,
    forkCharacteristics,
    // Resolved here rather than in the controller so the route param stays a
    // plain string: null for a grade the shared scale does not name, which opens
    // the picker unset instead of snapping the remix to a neighbouring grade.
    forkDifficultyId: getDifficultyIdForGradeName(forkDifficulty),
    sprayWallToken,
    editClimbUuid,
    onPublished: () => router.back(),
    onStartedNewClimb: handleStartedNewClimb,
    putBackReturn,
    onPutBackApplied: handlePutBackApplied,
  });

  const [longPressHoldId, setLongPressHoldId] = useState<number | null>(null);

  // The holds a reset took off the climb being edited or remixed: dashed ghost
  // rings, a banner, and the swap that puts a live hold in their place (#5493).
  const lostHolds = useLostHoldGhosts({
    board,
    sourceClimbUuid: editClimbUuid ?? (forkFrames ? (forkParentUuid ?? null) : null),
    sourceFrames: controller.sourceFrames,
    availableHoldIds: controller.availableHoldIds,
    frames: controller.frames,
    sprayWallToken,
    placeLostHoldReplacement: controller.placeLostHoldReplacement,
    initialReplacements: putBackInitialReplacements,
  });
  flagPutBackRoleFullRef.current = lostHolds.flagRoleFull;

  // "Put this hold back on the wall" — for whoever can edit the wall's holds.
  // A new hold goes on at the lost one's spot in the hold editor, and the climb
  // editor reopens with it in the lost hold's place (#5493).
  const sprayWallForPutBack = sprayLayoutId !== null ? getSprayWall(sprayLayoutId) : null;
  const canPutBack =
    sprayWallForPutBack !== null && sprayWallViewerCanEdit(board.boardName, board.layoutId) && sprayWallToken !== '';
  const { sheetGhost, canonicalLostHolds, closeSheet } = lostHolds;
  const { snapshotWorkingDraft } = controller;
  // One trip per screen: a second tap during the sheet's close animation would
  // start another request and pop a second route.
  const putBackStartedRef = useRef(false);
  const handlePutBack = useCallback(() => {
    const wall = sprayLayoutId !== null ? getSprayWall(sprayLayoutId) : null;
    const lostHold = sheetGhost ? canonicalLostHolds.get(sheetGhost.id) : undefined;
    if (!wall || !sheetGhost || !lostHold || putBackStartedRef.current) return;
    putBackStartedRef.current = true;
    closeSheet();
    const createParams: Record<string, string> = {
      boardName: board.boardName,
      layoutId: String(board.layoutId),
      sizeId: String(board.sizeId),
      setIds: board.setIds,
      angle: String(board.angle),
    };
    const optionalParams: Record<string, string | undefined> = {
      editClimbUuid,
      forkFrames,
      forkName,
      forkDescription,
      forkCharacteristics,
      forkDifficulty,
      forkParentUuid,
    };
    for (const [key, value] of Object.entries(optionalParams)) {
      if (value !== undefined) createParams[key] = value;
    }
    startLostHoldPutBack(
      {
        wallUuid: wall.wallUuid,
        layoutId: wall.layoutId,
        lostHold: { id: lostHold.id, cx: lostHold.cx, cy: lostHold.cy, r: lostHold.r, outline: lostHold.outline },
        placements: sheetGhost.placements,
        knownSuccessorIds: wall.holds.filter((hold) => hold.movedFromHoldId === lostHold.id).map((hold) => hold.id),
        createParams,
        draft: snapshotWorkingDraft(),
      },
      () => {
        if (router.canGoBack()) router.back();
        else router.replace('/(tabs)/climbs');
      },
    );
  }, [
    sprayLayoutId,
    sheetGhost,
    canonicalLostHolds,
    closeSheet,
    board,
    editClimbUuid,
    forkFrames,
    forkName,
    forkDescription,
    forkCharacteristics,
    forkDifficulty,
    forkParentUuid,
    snapshotWorkingDraft,
    router,
  ]);

  // The hold heatmap over the whole board (the create board has no list filters
  // to follow), counting the role the active brush paints: the downloaded board
  // answers, or the admin resolver, or, for a board that is not on this phone,
  // a line with a Download button where the autosave note sits. Inline rather
  // than a toast: toasts draw behind this native sheet.
  const [heatmapActive, setHeatmapActive] = useState(false);
  const heatmapInput = useMemo(
    () =>
      heatmapSearchInput(
        {
          boardName: board.boardName,
          layoutId: board.layoutId,
          sizeId: board.sizeId,
          setIds: board.setIds,
          angle: board.angle,
        },
        null,
      ),
    [board.boardName, board.layoutId, board.sizeId, board.setIds, board.angle],
  );
  const heatmapScope = useMemo(
    () => ({ boardName: board.boardName, layoutId: board.layoutId, sizeId: board.sizeId }),
    [board.boardName, board.layoutId, board.sizeId],
  );
  const { source: heatmapSource, isResolving: heatmapSourceResolving } = useCatalogQuerySourceState(heatmapScope);
  // Counts only: no brush colours by grade, so the grade column is never read.
  const heatmapQuery = useHoldHeatmap(heatmapInput, heatmapSource, heatmapActive && !heatmapSourceResolving);
  const { data: activeBoard } = useActiveBoard();
  const heatmapDownloadBoard =
    activeBoard &&
    activeBoard.boardType === board.boardName &&
    activeBoard.layoutId === board.layoutId &&
    activeBoard.sizeId === board.sizeId
      ? activeBoard
      : null;
  const { selectedBrush, setSelectedBrush } = controller;
  const toggleHeatmap = useCallback(() => {
    // Switching heat on with the eraser in hand would show nothing at all: pick
    // up the Hand brush, whose heat is the most useful default.
    if (!heatmapActive && selectedBrush === 'OFF') setSelectedBrush('HAND');
    // Functional, so two taps before a re-render still land as on → off.
    setHeatmapActive((active) => !active);
  }, [heatmapActive, selectedBrush, setSelectedBrush]);
  const heatmapStatus: CreateHeatmap['status'] =
    heatmapSource === 'download' && !heatmapSourceResolving
      ? 'download'
      : heatmapQuery.isError
        ? 'error'
        : heatmapQuery.isUnavailable
          ? 'unavailable'
          : 'ready';
  const heatmap = useMemo<CreateHeatmap>(
    () => ({
      active: heatmapActive,
      busy: heatmapActive && (heatmapSourceResolving || heatmapQuery.isFetching),
      statsByHoldId: heatmapQuery.statsByHoldId,
      metric: heatMetricForBrush(selectedBrush),
      climbCount: heatmapQuery.climbCount,
      status: heatmapStatus,
      downloadBoard: heatmapDownloadBoard,
      toggle: toggleHeatmap,
    }),
    [
      heatmapActive,
      heatmapSourceResolving,
      heatmapQuery.isFetching,
      heatmapQuery.statsByHoldId,
      selectedBrush,
      heatmapQuery.climbCount,
      heatmapStatus,
      heatmapDownloadBoard,
      toggleHeatmap,
    ],
  );

  const boardHolds = useMemo(
    () =>
      getCreateBoardHolds({
        boardName: board.boardName,
        layoutId: board.layoutId,
        sizeId: board.sizeId,
        setIds: board.setIds.split(',').map(Number),
      }),
    [board.boardName, board.layoutId, board.sizeId, board.setIds, sprayWallToken],
  );

  // Every dismiss path — chevron, pan-down, backdrop, hardware back — lands here.
  // No confirm on any of them: the autosave flush on unmount already keeps the
  // work, and a modal on the pan-down (the most-used gesture on this surface)
  // would be hostile. Just say it once, and only when the climber could
  // reasonably think it's gone — the controller decides that.
  //
  // Toast AFTER the pop, not before: the toast overlay is a root-level JS View
  // that renders behind any native sheet (see toast-provider), so firing it while
  // the drawer is still up shows nothing.
  const { notifyDraftKeptOnDismiss } = controller;
  const handleClose = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/climbs');
    notifyDraftKeptOnDismiss();
  }, [router, notifyDraftKeptOnDismiss]);

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

  // No hold geometry for this config, or a climb that doesn't belong on this
  // board size — either way there is no honest editor to draw, so say so rather
  // than seeding one with holds that mean something else on this wall.
  // The wall is still on its way. A spinner, not the unavailable state: nothing
  // has failed yet, and the editor opens the moment the holds arrive. See
  // `shouldAwaitWall` for why a catalogue board never reaches it.
  if (shouldAwaitWall(boardHolds != null, sprayLayoutId, sprayWallLoading)) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: systemColors.background }]} edges={['bottom']}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" />
          <Button title={tCommon('actions.close')} onPress={handleClose} />
        </View>
      </SafeAreaView>
    );
  }

  if (!boardHolds || controller.editSizeMismatch) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: systemColors.background }]} edges={['bottom']}>
        <View style={styles.centered}>
          <Icon name="boards" size={48} color={iosSystemColors.systemGray4} />
          <Text variant="headline" style={styles.centeredTitle}>
            {t('mobile.create.unavailable.title')}
          </Text>
          <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.centeredSubtitle}>
            {controller.editSizeMismatch
              ? t('mobile.create.unavailable.wrongSize')
              : t('mobile.create.unavailable.subtitle')}
          </Text>
          <Button title={tCommon('actions.close')} onPress={handleClose} />
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
        subSheetOpen={longPressHoldId !== null || lostHolds.sheetGhost !== null}
        onLoadDraft={handleLoadDraft}
        onClose={handleClose}
        onViewDuplicate={handleViewDuplicate}
        heatmap={heatmap}
        lostHolds={lostHolds}
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

      <LostHoldSheet
        ghost={lostHolds.sheetGhost}
        candidates={lostHolds.sheetCandidates}
        onUseNearby={lostHolds.startReplacing}
        onPutBack={canPutBack ? handlePutBack : undefined}
        onClose={lostHolds.closeSheet}
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
