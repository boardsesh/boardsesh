// Turns a canonical board URL into an open play drawer / climbs list.
//
// `app.boardsesh.com` serves the same URL shapes the Next app does, and Expo
// Router hands those to the entry routes under `app/[board_name]/…` and
// `app/b/[board_slug]/…`. Every one of them is a thin wrapper around the hook
// here: resolve the URL to a real `UserBoard`, adopt it as the active board,
// then hand off to the surfaces that already exist (the Climbs tab and the play
// drawer). Nothing renders a board from URL params directly — the whole app
// reads the active board, so adopting it is what makes a deep link work.
//
// Board resolution reuses `resolveBoardForSession`, the same owned-reuse /
// create-if-missing path a party-session join takes. The only thing this module
// adds is understanding the *named-slug* URL form (`/kilter/original/…`), which
// `parseBoardPath` deliberately doesn't parse.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import type { UserBoard } from '@boardsesh/shared-schema';
import { toBoardPath, type BoardRouteTarget } from './board-route-target';
import { useClimb } from '../graphql/hooks';
import { fetchBoardBySlug, useCreateBoard, useMyBoards } from '../graphql/hooks';
import { useSetActiveBoard } from '../graphql/use-active-board';
import { useAuth } from '../../providers/auth-provider';
import { useDrawerHost, type BoardConfig } from '../../providers/drawer-host-provider';
import { resolveBoardForSession } from '../board-path-to-user-board';
import { openClimbInPlayDrawer } from '../open-climb-in-play-drawer';

export type BoardRouteStatus = 'resolving' | 'not-found';

/**
 * Where the target came from, which decides two things the caller can't:
 *
 * - `deep-link` (the canonical URL routes): the URL is the user's entry point,
 *   so its board becomes the active board and the redirector lands them on the
 *   Climbs tab.
 * - `in-app`: the app itself pushed a climb reference it already has a config
 *   for (the `ref` branch of `openClimbInPlayDrawer`). Adopting that board would
 *   switch — or worse, mint — a board behind the user's back just because they
 *   tapped a tick on someone else's wall, so the config is used as given and the
 *   redirector pops back where it came from.
 */
export type BoardRouteMode = 'deep-link' | 'in-app';

const CLIMBS_TAB = '/(tabs)/climbs' as const;

/** The board config a URL carries outright — only the tuple form has one. */
function urlBoardConfig(target: BoardRouteTarget | null): BoardConfig | null {
  if (target?.kind !== 'list' && target?.kind !== 'climb') return null;
  const { boardName, layoutId, sizeId, setIds, angle } = target.board;
  return { boardName, layoutId, sizeId, setIds, angle };
}

/**
 * Resolve the URL's board to a `UserBoard` and adopt it as active. Runs once
 * per target; `null` while resolving, and `error` once the board can't be
 * resolved at all (dead slug, board config that no longer exists).
 */
function useAdoptedBoard(
  target: BoardRouteTarget | null,
  enabled: boolean,
): { board: UserBoard | null; error: boolean } {
  const { isAuthenticated } = useAuth();
  const myBoards = useMyBoards(undefined, { enabled: isAuthenticated });
  const createBoard = useCreateBoard();
  const setActiveBoard = useSetActiveBoard();

  const [board, setBoard] = useState<UserBoard | null>(null);
  const [error, setError] = useState(false);

  // Key the effect on the resolved path rather than the target object so a
  // re-render with an equivalent target doesn't re-run board creation.
  const boardPath = enabled && target ? toBoardPath(target) : null;
  // Only the tuple form can mint a board, and only that path reads the owned
  // list; a `/b/{slug}` URL resolves server-side.
  const needsOwnedBoards = target?.kind === 'list' || target?.kind === 'climb';
  const resolvedPathRef = useRef<string | null>(null);

  // The resolve effect deliberately runs once per path, so it must not close
  // over the first render's query objects — `myBoards.data` is exactly the value
  // that arrives late on a cold deep-link open.
  const queriesRef = useRef({ myBoards, createBoard, isAuthenticated });
  useEffect(() => {
    queriesRef.current = { myBoards, createBoard, isAuthenticated };
  });

  useEffect(() => {
    if (!boardPath || resolvedPathRef.current === boardPath) return;
    // A second URL through the same mounted route (tapping a link to another
    // climb on the web build reuses the screen) has to start from a clean slate,
    // or a stale board hands off for the new target and a stale error shows a
    // not-found over a URL that resolves fine.
    const hadPreviousPath = resolvedPathRef.current !== null;
    resolvedPathRef.current = boardPath;
    if (hadPreviousPath) {
      setBoard(null);
      setError(false);
    }

    let cancelled = false;
    void (async () => {
      try {
        const {
          myBoards: boardsQuery,
          createBoard: createBoardMutation,
          isAuthenticated: signedIn,
        } = queriesRef.current;
        // Same cold-start guard the join screen uses: an empty owned-board list
        // makes resolveBoardForSession mint a board the user already has, which
        // the backend rejects. Wait for the real list first — and treat a list we
        // couldn't fetch at all as unresolvable, since "no boards" and "we don't
        // know your boards" mint the same duplicate board otherwise.
        let ownedBoards: UserBoard[] = [];
        if (needsOwnedBoards && signedIn) {
          const myBoardsData = boardsQuery.data ?? (await boardsQuery.refetch()).data;
          if (!myBoardsData) throw new Error(`Could not load owned boards for ${boardPath}`);
          ownedBoards = myBoardsData.boards;
        }
        const resolved = await resolveBoardForSession(boardPath, {
          ownedBoards,
          createBoard: (input) => createBoardMutation.mutateAsync(input),
          fetchBoardBySlug,
        });
        if (cancelled) return;
        await setActiveBoard(resolved);
        if (cancelled) return;
        setBoard(resolved);
      } catch (resolveError) {
        if (__DEV__) console.warn('[board-route] could not resolve board from URL', boardPath, resolveError);
        if (!cancelled) setError(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [boardPath, needsOwnedBoards, setActiveBoard]);

  return { board, error };
}

/**
 * Drive a canonical board URL to its destination. Returns the status the entry
 * route should render — these routes are redirectors, so all they ever show is
 * a spinner or a not-found.
 */
export function useBoardRouteTarget(
  target: BoardRouteTarget | null,
  options?: { mode?: BoardRouteMode },
): BoardRouteStatus {
  const mode = options?.mode ?? 'deep-link';
  const adoptsBoard = mode === 'deep-link';
  const router = useRouter();
  const { openPlayDrawer } = useDrawerHost();
  const { board, error: boardError } = useAdoptedBoard(target, adoptsBoard);

  const wantsClimb = target?.kind === 'climb' || target?.kind === 'slug-climb';
  const climbUuid = wantsClimb ? target.climbUuid : undefined;

  // A tuple URL already carries the whole config, so its climb loads in parallel
  // with board adoption. A `/b/{slug}` URL carries none and has to wait for the
  // resolved board. One config feeds both the query and the drawer so the frames
  // the user sees can't drift from the ones we asked for.
  const configFromUrl = urlBoardConfig(target);
  const configFromBoard = useMemo<BoardConfig | null>(
    () =>
      board
        ? {
            boardName: board.boardType,
            layoutId: board.layoutId,
            sizeId: board.sizeId,
            setIds: board.setIds,
            angle: board.angle,
          }
        : null,
    [board],
  );
  const boardConfig = configFromUrl ?? configFromBoard;

  const climbQuery = useClimb(boardConfig && climbUuid ? { ...boardConfig, climbUuid } : null);
  const climb = climbQuery.data;

  // Hand off exactly once per target. The ref guards a re-render firing the open
  // again after we've already navigated away — but it holds the target it fired
  // for rather than a bare flag, so a second URL arriving on the same mounted
  // screen still gets its hand-off instead of sitting on the spinner forever.
  const targetKey = target ? `${toBoardPath(target)}#${wantsClimb ? climbUuid : ''}` : null;
  const handedOffRef = useRef<string | null>(null);
  useEffect(() => {
    if (!target || !targetKey || handedOffRef.current === targetKey) return;
    // A deep link has to land on the adopted board — the Climbs tab behind the
    // drawer renders whatever the active board is.
    if (adoptsBoard && !board) return;

    const leave = () => {
      if (!adoptsBoard && router.canGoBack()) {
        router.back();
        return;
      }
      router.replace(CLIMBS_TAB);
    };

    if (!wantsClimb) {
      handedOffRef.current = targetKey;
      leave();
      return;
    }

    if (!climb || !boardConfig) return;
    handedOffRef.current = targetKey;
    // preview:true so a deep-linked climb doesn't disturb the queue — in a
    // session it would change the shared current climb for everyone. The drawer
    // shows a "Preview" badge with "Set active" to opt into playing it.
    openClimbInPlayDrawer({ kind: 'climb', climb, boardConfig }, { openPlayDrawer, router }, { preview: true });
    leave();
  }, [adoptsBoard, board, boardConfig, climb, openPlayDrawer, router, target, targetKey, wantsClimb]);

  if (!target) return 'not-found';
  if (boardError) return 'not-found';
  // Only a settled query says the climb is gone: `isLoading` briefly reads false
  // in the render where the query switches on, which would flash a not-found
  // over a climb that is about to arrive.
  if (wantsClimb && (climbQuery.isError || (climbQuery.isSuccess && !climb))) return 'not-found';
  return 'resolving';
}
