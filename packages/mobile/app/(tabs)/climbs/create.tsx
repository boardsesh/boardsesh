import { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { SUPPORTED_BOARDS } from '@boardsesh/board-config';
import type { BoardName } from '@boardsesh/shared-schema';
import { CreateClimbScreen } from '../../../src/components/create-climb/CreateClimbScreen';
import { ActivityIndicator } from '../../../src/components/ActivityIndicator';
import { useActiveBoard } from '../../../src/lib/graphql/use-active-board';
import { createClimbScreenKey } from '../../../src/lib/create-climb-screen-key';
import { supportsClimbCreation } from '../../../src/lib/boards/supports-climb-creation';

type CreateClimbParams = {
  boardName?: string;
  layoutId?: string;
  sizeId?: string;
  setIds?: string;
  angle?: string;
  forkFrames?: string;
  forkName?: string;
  forkDescription?: string;
  editClimbUuid?: string;
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
 * A board that cannot have climbs set on it (Woods) is rejected the same way: the
 * Create/Fork/Edit entry points are already hidden for it, so anything arriving
 * here names it only via a hand-built link — and the editor cannot paint its
 * holds. Falling through to the active board keeps the route from rendering an
 * empty wall.
 */
function supportedBoardName(candidate: string | undefined): BoardName | undefined {
  if (candidate == null) return undefined;
  if (!supportsClimbCreation(candidate)) return undefined;
  return (SUPPORTED_BOARDS as readonly string[]).includes(candidate) ? (candidate as BoardName) : undefined;
}

/**
 * Create-climb route. Board config comes from route params (passed by the FAB,
 * fork/edit entry points); falls back to the user's active board when the
 * params are absent so the screen can be opened bare.
 */
export default function CreateClimbRoute() {
  const params = useLocalSearchParams<CreateClimbParams>();
  const { data: activeBoard } = useActiveBoard();

  const board = useMemo(() => {
    const boardName = supportedBoardName(params.boardName) ?? supportedBoardName(activeBoard?.boardType);
    const layoutId = params.layoutId ? Number(params.layoutId) : activeBoard?.layoutId;
    const sizeId = params.sizeId ? Number(params.sizeId) : activeBoard?.sizeId;
    const setIds = params.setIds ?? activeBoard?.setIds;
    const angle = params.angle ? Number(params.angle) : activeBoard?.angle;
    if (!boardName || layoutId == null || sizeId == null || setIds == null || angle == null) {
      return null;
    }
    return { boardName, layoutId, sizeId, setIds, angle };
  }, [params, activeBoard]);

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
      key={createClimbScreenKey(params.editClimbUuid, board)}
      board={board}
      forkFrames={params.forkFrames}
      forkName={params.forkName}
      forkDescription={params.forkDescription}
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
