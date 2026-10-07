import { useEffect, useMemo, useRef } from 'react';
import { View, StyleSheet } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { getBoardCapabilities, WOODS_ANGLES, WOODS_LAYOUTS, woodsSizeIdToDimension } from '@boardsesh/board-config';
// The schema includes spray walls; the board-picker list deliberately excludes them.
import { SUPPORTED_BOARDS, type BoardName, type UserBoard } from '@boardsesh/shared-schema';
import { CreateClimbScreen } from '../../../src/components/create-climb/CreateClimbScreen';
import { DevicePickerSheetHost } from '../../../src/components/ble/DevicePickerSheetHost';
import { ActivityIndicator } from '../../../src/components/ActivityIndicator';
import { useActiveBoard } from '../../../src/lib/graphql/use-active-board';
import { createClimbScreenKey } from '../../../src/lib/create-climb-screen-key';
import { useUnsupportedBoardExit } from '../../../src/lib/routing/use-unsupported-board-exit';
import { useSprayWallToken } from '../../../src/lib/spray/use-spray-wall-token';
import { useSprayWallArchiveSettled, useSprayWallIsArchived } from '../../../src/lib/spray/use-spray-wall-archive';

type CreateClimbParams = {
  boardName?: string | string[];
  layoutId?: string | string[];
  sizeId?: string | string[];
  setIds?: string | string[];
  angle?: string | string[];
  forkFrames?: string;
  forkName?: string;
  forkDescription?: string;
  forkCharacteristics?: string;
  /** The remixed climb's uuid, so the editor can draw the holds it lost. */
  forkParentUuid?: string;
  editClimbUuid?: string;
};

type EditorBoard = {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
};

/** Unknown names fall back to the active board without carrying their geometry. */
function supportedBoardName(candidate: unknown): BoardName | undefined {
  return typeof candidate === 'string' && (SUPPORTED_BOARDS as readonly string[]).includes(candidate)
    ? (candidate as BoardName)
    : undefined;
}

/** The active board as an editor tuple, or null when its board name isn't one we support. */
function activeBoardTuple(activeBoard: UserBoard | null | undefined): EditorBoard | null {
  if (!activeBoard) return null;
  const boardName = supportedBoardName(activeBoard.boardType);
  if (!boardName) return null;
  const { layoutId, sizeId, setIds, angle } = activeBoard;
  return { boardName, layoutId, sizeId, setIds, angle };
}

/** Validate stored/link geometry and the Woods sizes supported by its hold tables. */
function isAuthorableBoard(board: EditorBoard | null): board is EditorBoard {
  if (!board) return false;
  if (!Number.isFinite(board.layoutId) || !Number.isFinite(board.sizeId) || !Number.isFinite(board.angle)) return false;
  // Woods and spray walls do not require catalogue hold sets, so an empty string is valid.
  if (typeof board.setIds !== 'string') return false;
  if (!getBoardCapabilities(board.boardName).climbCreation) return false;
  if (board.boardName === 'woods') {
    return (
      board.layoutId === WOODS_LAYOUTS.woods.id &&
      woodsSizeIdToDimension(board.sizeId) !== undefined &&
      (WOODS_ANGLES as readonly number[]).includes(board.angle)
    );
  }
  return true;
}

function numericParam(parameter: string | string[] | undefined, fallback: number | undefined): number | undefined {
  if (parameter == null) return fallback;
  return typeof parameter === 'string' && parameter.trim() !== '' ? Number(parameter) : NaN;
}

/** A named board can borrow missing geometry only from the same active board. */
function resolveEditorBoard(params: CreateClimbParams, activeBoard: UserBoard | null | undefined): EditorBoard | null {
  const activeTuple = activeBoardTuple(activeBoard);
  const boardName = supportedBoardName(params.boardName);
  if (!boardName || !getBoardCapabilities(boardName).climbCreation) return activeTuple;

  const sameBoard = boardName === activeTuple?.boardName ? activeTuple : null;
  const layoutId = numericParam(params.layoutId, sameBoard?.layoutId);
  const sizeId = numericParam(params.sizeId, sameBoard?.sizeId);
  const setIds = params.setIds ?? sameBoard?.setIds;
  const angle = numericParam(params.angle, sameBoard?.angle);
  if (layoutId == null || sizeId == null || typeof setIds !== 'string' || angle == null) return null;
  return { boardName, layoutId, sizeId, setIds, angle };
}

type CreateExitReason =
  | 'boardCannotAuthor'
  | 'boardConfigIncomplete'
  | 'boardTypeUnsupported'
  | 'noUsableBoard'
  | 'wallArchived';

/**
 * Resolve failures separately from a pending active-board read.
 *
 * `wallArchived` is the resolved spray wall's archive state from the registry:
 * an archived wall keeps its climbs but takes no new climb and no edit, so a
 * deep link, a stale sheet or a queue item cannot open the editor on it.
 */
function createExitReason(
  params: CreateClimbParams,
  activeBoard: UserBoard | null | undefined,
  activeBoardPending: boolean,
  resolvedBoard: EditorBoard | null,
  wallArchived = false,
): CreateExitReason | null {
  const linkedBoard = supportedBoardName(params.boardName);
  if (linkedBoard != null && !getBoardCapabilities(linkedBoard).climbCreation) return 'boardCannotAuthor';

  if (resolvedBoard != null) {
    if (!getBoardCapabilities(resolvedBoard.boardName).climbCreation) return 'boardCannotAuthor';
    if (wallArchived) return 'wallArchived';
    return isAuthorableBoard(resolvedBoard) ? null : 'boardConfigIncomplete';
  }

  // An errored query also has undefined data; only isPending means keep waiting.
  if (activeBoardPending) return null;
  if (linkedBoard != null) return 'boardConfigIncomplete';
  if (activeBoard != null) return 'boardTypeUnsupported';
  return 'noUsableBoard';
}

/**
 * Create-climb route. Board config comes from route params (passed by the FAB,
 * fork/edit entry points); falls back to the user's active board when the
 * params are absent so the screen can be opened bare.
 */
export default function CreateClimbRoute() {
  const params = useLocalSearchParams<CreateClimbParams>();
  const { data: activeBoard, isPending: activeBoardPending } = useActiveBoard();
  const { t } = useTranslation('climbs');

  const resolvedBoard = useMemo(() => resolveEditorBoard(params, activeBoard), [params, activeBoard]);

  // `createClimbScreenKey` folds the spray wall's VERSION in, but it reads that
  // out of a module-level registry — and on a cold spray entry (a share link, a
  // remix of somebody else's wall climb) the wall lands after this route has
  // already rendered. Nothing here would re-render, so the screen would keep the
  // `-sv0` key: its editor never remounts, never re-runs the version-keyed draft
  // restore, and autosaves into a slot the loader's superseded-draft sweep has
  // been and gone past. Subscribing here is what makes the key move when the wall
  // arrives. `''` for every catalogue board.
  useSprayWallToken(resolvedBoard?.boardName, resolvedBoard?.layoutId);
  const wallArchived = useSprayWallIsArchived(resolvedBoard?.boardName, resolvedBoard?.layoutId ?? null);
  // A spray wall's archive state has to be known before the editor shows, or a
  // cold deep link onto an archived wall flashes the editor for a frame and then
  // leaves. "Known" includes a wall whose archive query failed (read as live)
  // and a wall that did not load at all (not archived): the server still refuses.
  const wallArchiveSettled = useSprayWallArchiveSettled(resolvedBoard?.boardName, resolvedBoard?.layoutId ?? null);
  // Once the editor is open, an archive learned later (a save refused as
  // archived re-reads the wall) is the save's to explain, in one message. The
  // route must not also leave with a second one.
  // A ref, not state: noting it must not cost the route a second render.
  const editorOpenedRef = useRef(false);
  const refuseArchivedWall = wallArchived && !editorOpenedRef.current;

  const exitReason = useMemo(
    () => createExitReason(params, activeBoard, activeBoardPending, resolvedBoard, refuseArchivedWall),
    [params, activeBoard, activeBoardPending, resolvedBoard, refuseArchivedWall],
  );
  const exitMessage = useMemo(() => {
    switch (exitReason) {
      case 'boardCannotAuthor':
        return t('createClimbForm.cannotOpen.boardCannotAuthor');
      case 'boardConfigIncomplete':
        return t('createClimbForm.cannotOpen.boardConfigIncomplete');
      case 'boardTypeUnsupported':
        return t('createClimbForm.cannotOpen.boardTypeUnsupported');
      case 'noUsableBoard':
        return t('createClimbForm.cannotOpen.noUsableBoard');
      case 'wallArchived':
        return t('createClimbForm.cannotOpen.wallArchived');
      default:
        return undefined;
    }
  }, [exitReason, t]);
  useUnsupportedBoardExit(exitReason != null, exitMessage);

  const showEditor = exitReason == null && resolvedBoard != null && wallArchiveSettled;
  useEffect(() => {
    if (showEditor) editorOpenedRef.current = true;
  }, [showEditor]);

  // Leave the climb list visible under the transparent modal while it dismisses.
  // Still claim the picker while dismissing: dropping the claim here would let
  // the app-root picker flash in behind this still-mounted modal for the one
  // frame before useUnsupportedBoardExit finishes leaving.
  if (exitReason != null) {
    return <DevicePickerSheetHost registerExternal />;
  }

  // The only honest spinners left: the active-board query hasn't answered yet,
  // or a spray wall has not said whether it is archived.
  if (!resolvedBoard || !wallArchiveSettled) {
    return (
      <>
        <View style={styles.loading}>
          <ActivityIndicator size="large" />
        </View>
        <DevicePickerSheetHost registerExternal />
      </>
    );
  }

  return (
    <>
      {/* Key by the edited climb AND the board's hold-identity tuple so switching
          drafts OR boards (e.g. a bare-open screen while the active board changes)
          remounts the editor — a clean re-seed, fresh undo history, and dropped
          holds that don't exist on the new layout/size. Angle is excluded so a
          session-sync angle change doesn't wipe an in-progress paint. */}
      <CreateClimbScreen
        key={createClimbScreenKey(params.editClimbUuid, resolvedBoard, params.forkFrames)}
        board={resolvedBoard}
        forkFrames={params.forkFrames}
        forkName={params.forkName}
        forkDescription={params.forkDescription}
        forkCharacteristics={params.forkCharacteristics}
        forkParentUuid={params.forkParentUuid}
        editClimbUuid={params.editClimbUuid}
      />
      {/* Host the BLE device picker from inside this route so a connect from the
          create-climb lightbulb presents OVER this transparentModal route instead
          of behind it. Claims the picker, suppressing the app-root instance while
          mounted — same fix as app/play.tsx (#5868). */}
      <DevicePickerSheetHost registerExternal />
    </>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
