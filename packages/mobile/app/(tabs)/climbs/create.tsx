import { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import {
  getBoardCapabilities,
  SUPPORTED_BOARDS,
  WOODS_ANGLES,
  WOODS_LAYOUTS,
  woodsSizeIdToDimension,
} from '@boardsesh/board-config';
import type { BoardName, UserBoard } from '@boardsesh/shared-schema';
import { CreateClimbScreen } from '../../../src/components/create-climb/CreateClimbScreen';
import { ActivityIndicator } from '../../../src/components/ActivityIndicator';
import { useActiveBoard } from '../../../src/lib/graphql/use-active-board';
import { createClimbScreenKey } from '../../../src/lib/create-climb-screen-key';
import { useUnsupportedBoardExit } from '../../../src/lib/routing/use-unsupported-board-exit';

type CreateClimbParams = {
  boardName?: string;
  layoutId?: string;
  sizeId?: string;
  setIds?: string;
  angle?: string;
  forkFrames?: string;
  forkName?: string;
  forkDescription?: string;
  forkCharacteristics?: string;
  editClimbUuid?: string;
};

type EditorBoard = {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
};

/**
 * Narrow an untrusted board name to a supported one, or `undefined`.
 *
 * `useLocalSearchParams` is untrusted input on this route: the app's
 * universal-link entry is a wildcard, so `…/climbs/create?boardName=<anything>`
 * can open it cold from outside the app. The value used to be cast straight to
 * `BoardName` and indexed into `STATE_TO_PRIMARY_CODE`, which throws during
 * render on the remix/edit path (#3804). Treating an unsupported value as absent
 * makes it fall back to the active board, exactly like a missing param.
 *
 * A board that cannot have climbs set on it (the climbCreation capability) is
 * NOT handled here — it would look identical to a typo and fall back to some
 * other board's wall, which is not what a link naming that board asked for.
 * `CreateClimbRoute` checks it separately and leaves the route.
 */
function supportedBoardName(candidate: string | undefined): BoardName | undefined {
  if (candidate == null) return undefined;
  return (SUPPORTED_BOARDS as readonly string[]).includes(candidate) ? (candidate as BoardName) : undefined;
}

/** The active board as an editor tuple, or null when its board name isn't one we support. */
function activeBoardTuple(activeBoard: UserBoard | null | undefined): EditorBoard | null {
  if (!activeBoard) return null;
  const boardName = supportedBoardName(activeBoard.boardType);
  if (!boardName) return null;
  const { layoutId, sizeId, setIds, angle } = activeBoard;
  return { boardName, layoutId, sizeId, setIds, angle };
}

/**
 * Can the editor actually open on this exact tuple?
 *
 * Two separate questions, both of which used to be one board-name check:
 *  - does the board allow authoring at all (the capability), and
 *  - is the SIZE one the board really has. That second one only bites on Woods,
 *    whose two sizes number their holds from their own origins (8x10: 0-484,
 *    12x12: 0-893). A link carrying any other size id resolves to no hold table,
 *    which would otherwise render an empty wall you can paint nothing on.
 */
function isAuthorableBoard(board: EditorBoard | null): board is EditorBoard {
  if (!board) return false;
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

/**
 * Resolve the board the editor opens on.
 *
 * The board name and its geometry travel as ONE tuple. A link that names a
 * supported board wins, and the active board fills in the parts the link left
 * out ONLY when it is that same board — carrying a link's `layoutId`/`sizeId`/
 * `setIds`/`angle` onto a *different* board would paint a wall the link never
 * described. A link that names nothing usable falls back to the active board
 * whole, which is how the bare-open (FAB, no params) case resolves.
 */
function resolveEditorBoard(params: CreateClimbParams, activeBoard: UserBoard | null | undefined): EditorBoard | null {
  const activeTuple = activeBoardTuple(activeBoard);
  const boardName = supportedBoardName(params.boardName);
  if (!boardName || !getBoardCapabilities(boardName).climbCreation) return activeTuple;

  const sameBoard = boardName === activeTuple?.boardName ? activeTuple : null;
  const layoutId = params.layoutId ? Number(params.layoutId) : sameBoard?.layoutId;
  const sizeId = params.sizeId ? Number(params.sizeId) : sameBoard?.sizeId;
  const setIds = params.setIds ?? sameBoard?.setIds;
  const angle = params.angle ? Number(params.angle) : sameBoard?.angle;
  if (layoutId == null || sizeId == null || setIds == null || angle == null) return null;
  return { boardName, layoutId, sizeId, setIds, angle };
}

/**
 * Create-climb route. Board config comes from route params (passed by the FAB,
 * fork/edit entry points); falls back to the user's active board when the
 * params are absent so the screen can be opened bare.
 */
export default function CreateClimbRoute() {
  const params = useLocalSearchParams<CreateClimbParams>();
  const { data: activeBoard } = useActiveBoard();

  const resolvedBoard = useMemo(() => resolveEditorBoard(params, activeBoard), [params, activeBoard]);

  // A board config the editor can't open has nowhere to land: it cannot paint
  // the holds, and silently swapping in a different board would set the climb on
  // the wrong wall. Leave the route rather than render a spinner that never
  // resolves.
  //
  // Checked on the LINK first (not just the resolved tuple), because a link that
  // names an uncreatable board must not fall through to the active board's wall —
  // it asked for that one. Then on the resolved tuple, which catches an
  // uncreatable or wrong-sized ACTIVE board by the same rule. `resolvedBoard`
  // being null while `activeBoard` is still undefined is the loading case, where
  // the spinner is the right answer, so it is deliberately not an exit.
  const linkNamesUncreatableBoard = params.boardName != null && !getBoardCapabilities(params.boardName).climbCreation;
  const resolvedBoardUnusable = resolvedBoard != null && !isAuthorableBoard(resolvedBoard);
  const namedBoardMissingGeometry =
    supportedBoardName(params.boardName) != null && resolvedBoard == null && activeBoard !== undefined;
  const cannotCreateHere = linkNamesUncreatableBoard || resolvedBoardUnusable || namedBoardMissingGeometry;
  useUnsupportedBoardExit(cannotCreateHere);

  const board = cannotCreateHere ? null : resolvedBoard;

  if (!board) {
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
      key={createClimbScreenKey(params.editClimbUuid, board, params.forkFrames)}
      board={board}
      forkFrames={params.forkFrames}
      forkName={params.forkName}
      forkDescription={params.forkDescription}
      forkCharacteristics={params.forkCharacteristics}
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
