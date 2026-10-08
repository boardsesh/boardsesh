import type { WindowAnchorPoint } from '../navigation/AnchoredPopover.types';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useIsFocused, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Button } from '../Button';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { openClimbInPlayDrawer } from '../../lib/open-climb-in-play-drawer';
import { getCreateBoardHolds } from '../../lib/create-board-holds';
import { useSprayWall } from '../../lib/spray/use-spray-wall';
import { useSprayWallToken } from '../../lib/spray/use-spray-wall-token';
import { isSprayBoard, shouldAwaitWall } from './spray-climb-rules';
import { ActivityIndicator } from '../ActivityIndicator';
import { spacing } from '../../theme/tokens';
import { HoldRoleSheet } from './HoldRoleSheet';
import { useLostHoldGhosts } from './use-lost-hold-ghosts';
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
  /** The remixed climb's uuid, so the editor can draw the holds it lost. */
  forkParentUuid?: string;
  editClimbUuid?: string;
};

/**
 * The New climb screen: a full-height modal task (see the route options in
 * app/(tabs)/climbs/_layout.tsx) whose body, CreateDrawer, carries the top bar,
 * the board, the brush + action rows, the metadata form and the Open Drafts
 * table. The long-press role picker presents above it. A successful publish
 * dismisses the screen so the success toast lands over the climbs list.
 */
export function CreateClimbScreen({
  board,
  forkFrames,
  forkName,
  forkDescription,
  forkCharacteristics,
  forkParentUuid,
  editClimbUuid,
}: CreateClimbScreenProps) {
  const { t } = useTranslation('climbs');
  const { t: tCommon } = useTranslation('common');
  const { systemColors } = useTheme();
  const router = useRouter();
  const { openPlayDrawer } = useDrawerHost();

  // Swapping the climb under the editor changes the route's params in place
  // rather than replacing the route: a replace would drop this modal and
  // present a new one, sliding the whole sheet away and back. The route keys
  // the editor on these params, so it still remounts with a fresh session.
  const handleStartedNewClimb = useCallback(() => {
    router.setParams(editorParams(board, undefined));
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

  const controller = useCreateClimbScreen({
    board,
    forkFrames,
    forkName,
    forkDescription,
    forkCharacteristics,
    sprayWallToken,
    editClimbUuid,
    onPublished: () => router.back(),
    onStartedNewClimb: handleStartedNewClimb,
  });

  const [longPressHoldId, setLongPressHoldId] = useState<number | null>(null);
  const [holdPopoverPoint, setHoldPopoverPoint] = useState<WindowAnchorPoint | null>(null);
  const editorRootRef = useRef<View>(null);
  const holdAnchorRevision = useRef(0);
  // Read by the back handler, so opening the sheet does not re-register it.
  const holdRoleOpenRef = useRef(false);
  holdRoleOpenRef.current = longPressHoldId !== null;

  // A remix of a climb that lost holds: a grey ring where each one was, and
  // Save waits until the climber has tapped them away. Never on an edit in place.
  const lostHolds = useLostHoldGhosts({
    board,
    parentClimbUuid: editClimbUuid ? null : (forkParentUuid ?? null),
    sourceFrames: controller.remixSourceFrames,
    availableHoldIds: controller.availableHoldIds,
    sprayWallToken,
  });

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

  // Both ways out — the X and Android's back — land here. (The iOS swipe-down
  // is off: see the route options.) No confirm: the autosave flush on unmount
  // already keeps the work. Just say it once, and only when the climber could
  // reasonably think it's gone — the controller decides that.
  //
  // Toast AFTER the pop, not before: the toast overlay is a root-level JS View
  // that renders behind a native modal (see toast-provider), so firing it while
  // the editor is still up shows nothing.
  const { notifyDraftKeptOnDismiss } = controller;
  const handleClose = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/climbs');
    notifyDraftKeptOnDismiss();
  }, [router, notifyDraftKeptOnDismiss]);

  // Android's back leaves the way the X does, so it also says the draft was
  // kept. Focus-gated: BackHandler runs the newest listener first, so an
  // unfocused editor would otherwise eat back presses on a screen above it.
  const isFocused = useIsFocused();
  useEffect(() => {
    if (!isFocused) return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      // The hold-role sheet is a native dialog that takes back itself, so this
      // should never run while it is up. If it does, back closes the sheet,
      // never the editor under it.
      if (holdRoleOpenRef.current) {
        setLongPressHoldId(null);
        return true;
      }
      handleClose();
      return true;
    });
    return () => subscription.remove();
  }, [isFocused, handleClose]);

  const handleLongPress = useCallback((holdId: number, anchor?: WindowAnchorPoint) => {
    const revision = ++holdAnchorRevision.current;
    if (anchor && editorRootRef.current) {
      editorRootRef.current.measureInWindow((rootX, rootY) => {
        if (revision !== holdAnchorRevision.current) return;
        setHoldPopoverPoint({ x: anchor.x - rootX, y: anchor.y - rootY });
        setLongPressHoldId(holdId);
      });
    } else {
      setHoldPopoverPoint(null);
      setLongPressHoldId(holdId);
    }
  }, []);
  const closeHoldRole = useCallback(() => {
    holdAnchorRevision.current += 1;
    setLongPressHoldId(null);
    setHoldPopoverPoint(null);
  }, []);

  const handleLoadDraft = useCallback(
    (climb: Climb) => {
      // Re-enter the editor in edit mode for the picked draft so the controller
      // re-seeds holds/name/description cleanly. The route's key (editClimbUuid)
      // forces a remount, giving a fresh editing session + undo history.
      router.setParams(editorParams(board, climb.uuid));
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
          <Icon name="boards" size={48} color={systemColors.tertiaryLabel} />
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
    <View ref={editorRootRef} collapsable={false} style={styles.container}>
      <CreateDrawer
        board={board}
        controller={controller}
        boardHolds={boardHolds}
        onLongPressHold={handleLongPress}
        onLoadDraft={handleLoadDraft}
        onClose={handleClose}
        onViewDuplicate={handleViewDuplicate}
        heatmap={heatmap}
        lostHolds={lostHolds}
      />

      <HoldRoleSheet
        holdId={longPressHoldId}
        anchorPoint={holdPopoverPoint}
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

/**
 * The route params for the editor on `board`: an edit of `editClimbUuid`, or a
 * blank climb. Every remix param is cleared, so a remix can't leak into the
 * next climb.
 */
function editorParams(board: CreateClimbBoard, editClimbUuid: string | undefined) {
  return {
    boardName: board.boardName,
    layoutId: String(board.layoutId),
    sizeId: String(board.sizeId),
    setIds: board.setIds,
    angle: String(board.angle),
    editClimbUuid,
    forkFrames: undefined,
    forkName: undefined,
    forkDescription: undefined,
    forkCharacteristics: undefined,
    forkParentUuid: undefined,
  };
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
