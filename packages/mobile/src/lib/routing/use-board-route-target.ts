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
//
// Resolution is local-first, then server, and never reactive. Every lookup here
// is imperative (`fetchAllMyBoards`, `fetchBoardBySlug`) because React Query
// runs `networkMode: 'offlineFirst'`: an awaited `refetch()` on a cold offline
// open pauses its retryer and never settles, so the route would spin forever
// over a climb that is sitting in the downloaded snapshot. A bare request
// rejects, and a rejection is a not-found the user can act on.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { onlineManager } from '@tanstack/react-query';
import type { CreateBoardInput, UserBoard } from '@boardsesh/shared-schema';
import { toBoardPath, type BoardRouteTarget } from './board-route-target';
import { useClimb } from '../graphql/hooks';
import { fetchAllMyBoards, fetchBoardBySlug, fetchBoardByUuid, useCreateBoard } from '../graphql/hooks';
import { readDuplicateBoardError } from '../graphql/extract-error-message';
import { useSetActiveBoard } from '../graphql/use-active-board';
import { getStoredActiveBoard } from '../active-board-store';
import { getOfflineBoards } from '../../settings/offline-boards';
import { useAuth } from '../../providers/auth-provider';
import { useDrawerHost, type BoardConfig } from '../../providers/drawer-host-provider';
import {
  findOwnedBoardForSession,
  parseBoardConfigFromPath,
  resolveBoardForSession,
} from '../board-path-to-user-board';
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
 * The board snapshots this device holds that may answer a URL, best first.
 *
 * The stored active board is always fair game: it's the board every other
 * surface is already pointed at, so adopting it can't surprise anyone, and
 * matching it skips the owned-list round trip on the overwhelmingly common deep
 * link — your own wall.
 *
 * The offline cards are consulted ONLY while offline. Online the server list is
 * authoritative, and a card for a board deleted on another device outlives the
 * board until a complete `myBoards` fetch prunes it; adopting one would write a
 * uuid the backend no longer knows into the active-board store, which is exactly
 * the board-presence poisoning `offline-boards.ts` refuses to risk.
 */
async function localBoardCandidates(): Promise<UserBoard[]> {
  const activeBoard = await getStoredActiveBoard();
  const offlineCards = onlineManager.isOnline() ? [] : getOfflineBoards();
  return activeBoard ? [activeBoard, ...offlineCards] : offlineCards;
}

/** A local board matching a tuple URL's config, with the URL's angle applied. */
async function findLocalBoardForPath(boardPath: string): Promise<UserBoard | null> {
  const config = parseBoardConfigFromPath(boardPath);
  if (!config) return null;
  return findOwnedBoardForSession(await localBoardCandidates(), config) ?? null;
}

/** A local board carrying `slug`, for the `/b/{slug}` form. */
async function findLocalBoardForSlug(slug: string): Promise<UserBoard | null> {
  return (await localBoardCandidates()).find((candidate) => candidate.slug === slug) ?? null;
}

/**
 * `createBoard`, with the server's duplicate rejection recovered into the board
 * it names.
 *
 * Walking the owned list first closes the common case but not the race: a board
 * with this config created on another device between that walk and this create
 * still comes back as BOARD_DUPLICATE_CONFIG. The rejection carries the existing
 * board's uuid precisely so a client needn't search a paginated list for it — so
 * a URL that would otherwise dead-end as not-found adopts the board the user
 * already has. The angle comes off the create input, which is the URL's.
 */
async function createBoardOrAdoptDuplicate(
  input: CreateBoardInput,
  createBoard: (input: CreateBoardInput) => Promise<UserBoard>,
): Promise<UserBoard> {
  try {
    return await createBoard(input);
  } catch (createError) {
    const duplicate = readDuplicateBoardError(createError);
    if (!duplicate) throw createError;
    const existing = await fetchBoardByUuid(duplicate.boardUuid);
    // A duplicate naming a board we then can't read is a dead end, not a
    // fallback: re-throw the create rejection rather than the lookup's, since
    // that's the failure that actually describes what happened.
    if (!existing) throw createError;
    // `CreateBoardInput.angle` is optional on the wire; `buildCreateBoardInput`
    // always fills it from the URL, and the board's own angle is the fallback.
    const angle = input.angle ?? existing.angle;
    return existing.angle === angle ? existing : { ...existing, angle };
  }
}

/**
 * Resolve the URL's board to a `UserBoard` and adopt it as active. Runs once
 * per target; `null` while resolving, and `error` once the board can't be
 * resolved at all (dead slug, board config that no longer exists, offline with
 * nothing local that matches).
 */
function useAdoptedBoard(
  target: BoardRouteTarget | null,
  enabled: boolean,
): { board: UserBoard | null; error: boolean } {
  const { isAuthenticated, isLoading: authIsLoading } = useAuth();
  const createBoard = useCreateBoard();
  const setActiveBoard = useSetActiveBoard();

  const [board, setBoard] = useState<UserBoard | null>(null);
  const [error, setError] = useState(false);

  // Only the tuple form can mint a board, and only that path reads the owned
  // list; a `/b/{slug}` URL resolves by slug, locally or server-side.
  const needsOwnedBoards = target?.kind === 'list' || target?.kind === 'climb';
  // Resolution must not start on an unsettled session. A signed-in state that
  // hasn't resolved yet reads as signed-out, which skips the owned-boards wait
  // below and mints a duplicate of a board the user already has (or fails
  // outright when the create needs auth). Today `AuthProvider` holds the whole
  // route tree behind a splash until the session lands, so this never fires —
  // but that's the provider's invariant, not this hook's, and a cold deep-link
  // open is exactly where it would bite. The `/b/{slug}` form needs no session
  // at all (public `boardBySlug`, local `setActiveBoard`), so it stays eager.
  const waitingForAuth = needsOwnedBoards && authIsLoading;
  // Key the effect on the resolved path rather than the target object so a
  // re-render with an equivalent target doesn't re-run board creation.
  const boardPath = enabled && target && !waitingForAuth ? toBoardPath(target) : null;
  const resolvedPathRef = useRef<string | null>(null);

  // The resolve effect deliberately runs once per path, so it must not close
  // over the first render's values — the session is exactly the one that lands
  // late on a cold deep-link open.
  const queriesRef = useRef({ createBoard, isAuthenticated });
  useEffect(() => {
    queriesRef.current = { createBoard, isAuthenticated };
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
        const { createBoard: createBoardMutation, isAuthenticated: signedIn } = queriesRef.current;
        // Local first, before anything can wait on the network. The deep-linked
        // board is nearly always the board this device is already on, and on a
        // cold offline open it's the only board resolvable at all — the climb
        // itself already serves from the downloaded snapshot.
        const localBoard = needsOwnedBoards ? await findLocalBoardForPath(boardPath) : null;

        let ownedBoards: UserBoard[] = [];
        if (needsOwnedBoards && !localBoard) {
          // Offline with nothing local is unresolvable and has to say so rather
          // than wait: every remaining step (the owned-list walk, CREATE_BOARD)
          // needs the network. Failing here is what turns an endless spinner
          // into the route's not-found.
          if (!onlineManager.isOnline()) {
            throw new Error(`No downloaded board matches ${boardPath} while offline`);
          }
          // Same cold-start guard the join screen uses: an empty owned-board list
          // makes resolveBoardForSession mint a board the user already has, which
          // the backend rejects. Fetch the *whole* list — `myBoards` pages at 50,
          // and a board on page two reads as no board at all — and let a rejected
          // walk fail the resolve, since "no boards" and "we don't know your
          // boards" mint the same duplicate otherwise. Signed out is legitimately
          // empty: there the create fails, and that rejection is the not-found.
          if (signedIn) ownedBoards = await fetchAllMyBoards();
        }

        const resolved =
          localBoard ??
          (await resolveBoardForSession(boardPath, {
            ownedBoards,
            createBoard: (input) =>
              createBoardOrAdoptDuplicate(input, (createInput) => createBoardMutation.mutateAsync(createInput)),
            // Local first here too, so a named board already on the device opens
            // offline. The named-path angle rule (URL angle, else the board's
            // own) stays inside `resolveBoardForSession` for both branches.
            fetchBoardBySlug: async (slug) => (await findLocalBoardForSlug(slug)) ?? (await fetchBoardBySlug(slug)),
          }));
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
    const openDrawer = () =>
      openClimbInPlayDrawer({ kind: 'climb', climb, boardConfig }, { openPlayDrawer, router }, { preview: true });

    // Order matters, and it's opposite for the two modes. `openPlayDrawer`
    // navigates to `/play`, so on a deep link (which leaves by *replacing* the
    // redirector — there's nothing behind it on a cold open) opening first would
    // put `/play` on top and then replace `/play` itself: the drawer never
    // appears and the user lands on a bare Climbs tab. Replace first, then push
    // the drawer over the tab. The in-app mode pops instead of replacing, and
    // popping before the push would take the screen the drawer is meant to
    // return to with it, so it keeps opening first.
    if (adoptsBoard) {
      leave();
      openDrawer();
      return;
    }
    openDrawer();
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
