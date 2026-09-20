import { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { getBoardCapabilities, WOODS_ANGLES, WOODS_LAYOUTS, woodsSizeIdToDimension } from '@boardsesh/board-config';
// The schema includes spray walls; the board-picker list deliberately excludes them.
import { SUPPORTED_BOARDS, type BoardName, type UserBoard } from '@boardsesh/shared-schema';
import { CreateClimbScreen } from '../../../src/components/create-climb/CreateClimbScreen';
import { ActivityIndicator } from '../../../src/components/ActivityIndicator';
import { useActiveBoard } from '../../../src/lib/graphql/use-active-board';
import { createClimbScreenKey } from '../../../src/lib/create-climb-screen-key';
import { useUnsupportedBoardExit } from '../../../src/lib/routing/use-unsupported-board-exit';
import { useSprayWallToken } from '../../../src/lib/spray/use-spray-wall-token';

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
  /** The source climb's grade, as a name on the shared scale ("6c/V5"). */
  forkDifficulty?: string;
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

type CreateExitReason = 'boardCannotAuthor' | 'boardConfigIncomplete' | 'boardTypeUnsupported' | 'noUsableBoard';

/** Resolve failures separately from a pending active-board read. */
function createExitReason(
  params: CreateClimbParams,
  activeBoard: UserBoard | null | undefined,
  activeBoardPending: boolean,
  resolvedBoard: EditorBoard | null,
): CreateExitReason | null {
  const linkedBoard = supportedBoardName(params.boardName);
  if (linkedBoard != null && !getBoardCapabilities(linkedBoard).climbCreation) return 'boardCannotAuthor';

  if (resolvedBoard != null) {
    if (!getBoardCapabilities(resolvedBoard.boardName).climbCreation) return 'boardCannotAuthor';
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

  const exitReason = useMemo(
    () => createExitReason(params, activeBoard, activeBoardPending, resolvedBoard),
    [params, activeBoard, activeBoardPending, resolvedBoard],
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
      default:
        return undefined;
    }
  }, [exitReason, t]);
  useUnsupportedBoardExit(exitReason != null, exitMessage);

  // Leave the climb list visible under the transparent modal while it dismisses.
  if (exitReason != null) return null;

  // The only honest spinner left: the active-board query hasn't answered yet.
  if (!resolvedBoard) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    // Key by the edited climb AND the board's hold-identity tuple so switching
    // drafts OR boards (e.g. a bare-open screen while the active board changes)
    // remounts the editor — a clean re-seed, fresh undo history, and dropped
    // holds that don't exist on the new layout/size. Angle is excluded so a
    // session-sync angle change doesn't wipe an in-progress paint.
    <CreateClimbScreen
      key={createClimbScreenKey(params.editClimbUuid, resolvedBoard, params.forkFrames)}
      board={resolvedBoard}
      forkFrames={params.forkFrames}
      forkName={params.forkName}
      forkDescription={params.forkDescription}
      forkCharacteristics={params.forkCharacteristics}
      forkDifficulty={params.forkDifficulty}
      editClimbUuid={params.editClimbUuid}
    />
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
