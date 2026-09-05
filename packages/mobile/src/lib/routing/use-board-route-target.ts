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
//
// Losing the paused retryer costs one thing worth replacing: it used to resume
// when the network came back, so a link opened with no signal eventually landed.
// `useAdoptedBoard` therefore watches `onlineManager` and re-runs a resolve that
// failed while offline — the redirector renders a static not-found with no retry
// affordance, so without that the first tap would be a permanent dead end.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { onlineManager } from '@tanstack/react-query';
import { isNetworkError } from '@boardsesh/offline-sync/error-classification';
import type { Climb, UserBoard } from '@boardsesh/shared-schema';
import { toBoardPath, type BoardRouteTarget } from './board-route-target';
// The platform switch is this constant, not `Platform.OS` — the hook then needs
// no `react-native` import, whose RN 0.86 Flow entry the vitest node env cannot
// parse (see the config's `hooks-dual-write` exclusion note).
import { RELAXES_ANONYMOUS_ROUTES } from './anonymous-auth-gate';
import { useClimb } from '../graphql/hooks';
import { fetchAllMyBoards, fetchBoardBySlug, useCreateBoard } from '../graphql/hooks';
import { createBoardOrAdoptDuplicate } from '../graphql/create-board-or-adopt-duplicate';
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

/**
 * What the entry route should draw.
 *
 * A successful hand-off has no status of its own. The screen keeps its spinner
 * right up to the moment it leaves the tree, and a status that says "handed off"
 * could not be observed anyway — the hand-off effect navigates this screen away
 * in the same React batch a state update would land in, so the render carrying
 * it never commits. `onHandedOff` is how a caller hears about it instead.
 *
 * `auth-required` and `anonymous-climb` are both reachable on web only: the
 * browser export serves these routes to signed-out visitors. Which of the two a
 * signed-out visitor gets is the whole point of this hook's gate — a climb URL
 * renders read-only in place (`anonymous-climb`), everything else still hands
 * the path to login (`auth-required`).
 */
export type BoardRouteStatus = 'resolving' | 'not-found' | 'auth-required' | 'anonymous-climb';

/**
 * What the entry route should draw, plus what it needs to draw it.
 *
 * `climb` and `boardConfig` are populated for `anonymous-climb` only. Every
 * other status is a redirector state, and the redirector needs no data — the
 * signed-in path never returns a climb here because it hands one to the play
 * drawer imperatively and navigates away.
 */
export type BoardRouteResult = {
  status: BoardRouteStatus;
  climb: Climb | null;
  boardConfig: BoardConfig | null;
  /**
   * Whether the board the climb is on can actually be tilted. Only a resolved
   * board record carries the answer, so a `/b/{slug}` climb gets the gym's real
   * setting and a config-tuple URL — which has no board record at all — keeps the
   * same `true` the create path defaults to. Dropping it here is how an anonymous
   * reader ends up with an angle pill for a wall bolted at one angle.
   */
  isAngleAdjustable: boolean;
};

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
 * The downloaded cards are narrower, hence `includeOfflineCards`. On the happy
 * path they're consulted only while offline: online the server list is
 * authoritative, and a card for a board deleted on another device outlives the
 * board until a complete `myBoards` fetch prunes it; adopting one would write a
 * uuid the backend no longer knows into the active-board store, which is exactly
 * the board-presence poisoning `offline-boards.ts` refuses to risk.
 *
 * They ARE consulted after a network-shaped rejection, whatever `onlineManager`
 * claims — the same second look `offlineAwareRequest` takes in its catch block,
 * for the same reason: the manager's NetInfo seed is async and defaults true, and
 * it tracks `isConnected`, not `isInternetReachable`, so a captive portal, a dead
 * gym uplink or a lost cold-start race all read as online. A request that
 * demonstrably failed to reach the server is better evidence than the flag, and
 * the caller only reaches that branch once the server has proven unreachable.
 */
async function localBoardCandidates(includeOfflineCards: boolean): Promise<UserBoard[]> {
  const activeBoard = await getStoredActiveBoard();
  const offlineCards = includeOfflineCards ? getOfflineBoards() : [];
  return activeBoard ? [activeBoard, ...offlineCards] : offlineCards;
}

/** A local board matching a tuple URL's config, with the URL's angle applied. */
async function findLocalBoardForPath(boardPath: string, includeOfflineCards: boolean): Promise<UserBoard | null> {
  const config = parseBoardConfigFromPath(boardPath);
  if (!config) return null;
  return findOwnedBoardForSession(await localBoardCandidates(includeOfflineCards), config) ?? null;
}

/** A local board carrying `slug`, for the `/b/{slug}` form. */
async function findLocalBoardForSlug(slug: string, includeOfflineCards: boolean): Promise<UserBoard | null> {
  return (await localBoardCandidates(includeOfflineCards)).find((candidate) => candidate.slug === slug) ?? null;
}

/**
 * Resolve a named board, preferring what's already on the device and falling
 * back to the downloaded cards when the lookup can't reach the server.
 *
 * Only a network-shaped rejection earns that second look: a 403 or a validation
 * refusal is the server's verdict on a board we may no longer be allowed to see,
 * and adopting a stale card over it would hand the user a board the backend has
 * disowned.
 */
async function resolveBoardSlugLocalFirst(slug: string): Promise<UserBoard | null> {
  const localBoard = await findLocalBoardForSlug(slug, !onlineManager.isOnline());
  if (localBoard) return localBoard;
  try {
    return await fetchBoardBySlug(slug);
  } catch (slugError) {
    if (!isNetworkError(slugError)) throw slugError;
    const downloadedBoard = await findLocalBoardForSlug(slug, true);
    if (!downloadedBoard) throw slugError;
    return downloadedBoard;
  }
}

/**
 * A finished resolve, tagged with the path it finished for. `board: null` means
 * that path is unresolvable.
 *
 * The tag is load-bearing. When a second URL lands on the same mounted screen,
 * the new `boardPath` is visible a full render before the resolve effect can
 * clear anything, so an untagged board would still read as the PREVIOUS target's
 * — and the hand-off effect, which only asks whether *a* board exists, would
 * fire for the new target with the old board adopted: drawer on climb B, Climbs
 * tab and BLE still on board A, and B's in-flight create minting a server board
 * nobody ever adopts. Comparing the tag makes "resolved for the path being asked
 * about" the only way to read a board out of here, and retires the stale-error
 * flash on the same edge.
 */
type AdoptedBoardState = { path: string; board: UserBoard | null };

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

  const [adopted, setAdopted] = useState<AdoptedBoardState | null>(null);
  // Bumped by the reconnect watcher below to re-enter the resolve effect for a
  // path it has already run — the only thing that distinguishes a retry from the
  // re-renders the effect deliberately ignores.
  const [retryNonce, setRetryNonce] = useState(0);

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

  // Only a resolve that finished for THIS path may be read; see AdoptedBoardState.
  const settled = adopted && adopted.path === boardPath ? adopted : null;
  const board = settled?.board ?? null;
  const error = settled?.board === null;

  // The resolve effect deliberately runs once per path, so it must not close
  // over the first render's values — the session is exactly the one that lands
  // late on a cold deep-link open.
  const queriesRef = useRef({ createBoard, isAuthenticated });
  useEffect(() => {
    queriesRef.current = { createBoard, isAuthenticated };
  });

  // Same trick for the reconnect watcher, which subscribes once and must not
  // re-subscribe (and so miss a transition) every time the path or error moves.
  const resolveStateRef = useRef({ boardPath, error });
  useEffect(() => {
    resolveStateRef.current = { boardPath, error };
  });

  // Heal a resolve that failed because the device had no network.
  //
  // Only an offline→online TRANSITION retries. A dead slug or a deleted board
  // fails while online, and no transition can follow without the device having
  // gone offline first, so a genuine not-found is never disturbed — and a retry
  // that fails again can't loop, since it needs another round trip through
  // offline to fire a second time.
  useEffect(() => {
    let wasOffline = !onlineManager.isOnline();
    return onlineManager.subscribe((online) => {
      const cameOnline = online && wasOffline;
      wasOffline = !online;
      if (!cameOnline) return;
      const { boardPath: failedPath, error: failed } = resolveStateRef.current;
      if (!failedPath || !failed) return;
      // Clearing the ref is what lets the effect re-enter for the same path;
      // the nonce is what re-runs it at all.
      resolvedPathRef.current = null;
      setAdopted(null);
      setRetryNonce((previousNonce) => previousNonce + 1);
    });
  }, []);

  useEffect(() => {
    if (!boardPath || resolvedPathRef.current === boardPath) return;
    // The marker claims the path for the duration of the run so re-renders don't
    // re-enter it. A run that never finishes gives the claim back in the cleanup
    // below — nothing else does, and a stale claim is unrecoverable.
    resolvedPathRef.current = boardPath;

    let cancelled = false;
    let settledThisRun = false;
    void (async () => {
      try {
        const { createBoard: createBoardMutation, isAuthenticated: signedIn } = queriesRef.current;
        // Local first, before anything can wait on the network. The deep-linked
        // board is nearly always the board this device is already on, and on a
        // cold offline open it's the only board resolvable at all — the climb
        // itself already serves from the downloaded snapshot.
        let localBoard = needsOwnedBoards ? await findLocalBoardForPath(boardPath, !onlineManager.isOnline()) : null;

        let ownedBoards: UserBoard[] = [];
        if (needsOwnedBoards && !localBoard) {
          // Offline with nothing local is unresolvable and has to say so rather
          // than wait: every remaining step (the owned-list walk, CREATE_BOARD)
          // needs the network. Failing here is what turns an endless spinner
          // into the route's not-found — and the reconnect watcher above is what
          // keeps that not-found from being permanent.
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
          if (signedIn) {
            try {
              ownedBoards = await fetchAllMyBoards();
            } catch (listError) {
              // `onlineManager` said online and the walk still never reached the
              // server, so it was lying (captive portal, dead uplink, lost
              // cold-start seed race). Take the downloaded cards' second look
              // before giving up, exactly as `offlineAwareRequest` does — but
              // only for a transport failure. A rejection carrying a server
              // status is a verdict, and adopting a stale card over it would
              // hand back a board the backend has disowned.
              if (!isNetworkError(listError)) throw listError;
              localBoard = await findLocalBoardForPath(boardPath, true);
              if (!localBoard) throw listError;
            }
          }
        }

        const resolved =
          localBoard ??
          (await resolveBoardForSession(boardPath, {
            // Already walked above (or deliberately left empty for a signed-out
            // visitor), so the loader hands the list straight back rather than
            // fetching it twice.
            loadOwnedBoards: async () => ownedBoards,
            createBoard: (input) =>
              createBoardOrAdoptDuplicate(input, (createInput) => createBoardMutation.mutateAsync(createInput)),
            // Local first here too, so a named board already on the device opens
            // offline. The named-path angle rule (URL angle, else the board's
            // own) stays inside `resolveBoardForSession` for both branches.
            fetchBoardBySlug: resolveBoardSlugLocalFirst,
          }));
        if (cancelled) return;
        await setActiveBoard(resolved);
        if (cancelled) return;
        settledThisRun = true;
        setAdopted({ path: boardPath, board: resolved });
      } catch (resolveError) {
        if (__DEV__) console.warn('[board-route] could not resolve board from URL', boardPath, resolveError);
        if (cancelled) return;
        settledThisRun = true;
        setAdopted({ path: boardPath, board: null });
      }
    })();

    return () => {
      cancelled = true;
      // Give the claim back when the run was cut short, or the path is marked
      // resolved while nothing ever resolved it: a re-run with the SAME path
      // early-returns on the marker and the redirector sits on its spinner with
      // no way out. StrictMode replays every dev mount, Fast Refresh does the
      // same, and `authIsLoading` flipping true mid-resolve blanks `boardPath`
      // and restores it — all three land here. A replayed run can double-fire
      // CREATE_BOARD in a narrow race, which the duplicate recovery absorbs.
      if (!settledThisRun && resolvedPathRef.current === boardPath) resolvedPathRef.current = null;
    };
    // `retryNonce` is a dep purely so a reconnect re-enters this effect; nothing
    // in the body reads it.
  }, [boardPath, needsOwnedBoards, retryNonce, setActiveBoard]);

  return { board, error };
}

/**
 * The board behind a `/b/{slug}` climb URL for a reader with no account.
 *
 * Separate from `useAdoptedBoard` rather than a mode inside it, because almost
 * nothing it does applies: there is no owned-board list to walk, no board to
 * mint, and no active board to write. What is left is one public read.
 *
 * Server only — deliberately no local-first pass. The device's stored active
 * board and downloaded cards belong to whoever last signed in on this browser,
 * and matching a slug against them would show an anonymous reader a board from
 * somebody else's session. The offline healing `useAdoptedBoard` does is absent
 * for the same reason: this path only exists on the web export.
 *
 * `boardBySlug` returns `null` for a board a signed-out viewer may not see,
 * indistinguishable from one that does not exist. That ambiguity is why
 * `'unresolved'` is a state of its own rather than an error — see the call site
 * for what the route does with it.
 */
type AnonymousSlugBoard =
  /** The read is still in flight, or there is no slug to read. */
  | { state: 'pending' }
  | { state: 'resolved'; board: UserBoard }
  /**
   * The read came back with nothing — a private board, a gym board scoped to its
   * members, a typo, or a failed request. Deliberately ONE state: the resolver
   * masks all of them to the same `null` on purpose, so the route cannot tell
   * them apart and must not pretend to.
   */
  | { state: 'unresolved' };

function useAnonymousSlugBoard(slug: string | null): AnonymousSlugBoard {
  const [resolved, setResolved] = useState<{ slug: string; board: UserBoard | null } | null>(null);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    void fetchBoardBySlug(slug)
      .then((board) => {
        if (!cancelled) setResolved({ slug, board });
      })
      .catch((slugError) => {
        if (__DEV__) console.warn('[board-route] could not resolve anonymous board slug', slug, slugError);
        if (!cancelled) setResolved({ slug, board: null });
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // Same tagging rule as `useAdoptedBoard`: a result may only be read for the
  // slug it was fetched for, so a second URL through the same mounted screen
  // cannot render the previous board.
  const settled = resolved && resolved.slug === slug ? resolved : null;
  // A named state rather than a `board === null` reading: that one is correct
  // only because an unsettled read is `undefined` and a resolved-empty one is
  // `null`, a distinction the next refactor of this state would quietly lose —
  // and losing it turns every in-flight read into a dead end.
  if (!settled) return { state: 'pending' };
  return settled.board ? { state: 'resolved', board: settled.board } : { state: 'unresolved' };
}

/**
 * The status, in the order the checks have to run.
 *
 * A URL that did not parse is a dead end whatever the session is, so it leads.
 * `auth-required` then comes before every RESOLUTION check: a signed-out visitor
 * has no board to fail on, and nothing was asked of the server on their behalf.
 */
function resolveStatus({
  parsedUrl,
  authRequired,
  boardError,
  climbIsGone,
  anonymousClimbReady,
}: {
  parsedUrl: boolean;
  authRequired: boolean;
  boardError: boolean;
  climbIsGone: boolean;
  anonymousClimbReady: boolean;
}): BoardRouteStatus {
  if (!parsedUrl) return 'not-found';
  if (authRequired) return 'auth-required';
  if (boardError) return 'not-found';
  if (climbIsGone) return 'not-found';
  if (anonymousClimbReady) return 'anonymous-climb';
  return 'resolving';
}

/**
 * Drive a canonical board URL to its destination. Returns the status the entry
 * route should render — these routes are redirectors, so all they ever show is
 * a spinner or a not-found.
 */
export function useBoardRouteTarget(
  target: BoardRouteTarget | null,
  options?: { mode?: BoardRouteMode; onHandedOff?: () => void; anonymousClimbEnabled?: boolean },
): BoardRouteResult {
  const mode = options?.mode ?? 'deep-link';
  const adoptsBoard = mode === 'deep-link';
  const router = useRouter();
  const { openPlayDrawer } = useDrawerHost();
  const { isAuthenticated, isLoading: authIsLoading } = useAuth();
  // Only reachable on web: the native gate never serves these routes signed-out,
  // because `RELAXES_ANONYMOUS_ROUTES` is a literal `false` in the native fork.
  // That constant — never a `Platform.OS` check, which would put the web
  // behaviour in the native bundle — is what holds the store fleet still across
  // the OTA this ships in. An unsettled session waits: bouncing on `isLoading`
  // would send a signed-in visitor to login on every cold open.
  const signedOutOnWeb = RELAXES_ANONYMOUS_ROUTES && adoptsBoard && !authIsLoading && !isAuthenticated;
  // A climb URL is renderable with no account at all. Every input is in the URL
  // — the tuple carries the whole board config, board art is a local catalogue
  // lookup, and the `climb` resolver takes no viewer — so the route draws it in
  // place instead of handing the visitor to a login form. Everything else (the
  // list surfaces) still needs a board, and minting one is `requireAuthenticated`.
  //
  // `anonymousClimbEnabled` defaults ON: it carries a KILL switch, and the
  // default has to be the feature. A flag that must resolve before the anonymous
  // branch turns on would show a login redirect as the first frame of the very
  // surface this exists to build.
  const anonymousClimbUrl =
    signedOutOnWeb &&
    (options?.anonymousClimbEnabled ?? true) &&
    (target?.kind === 'climb' || target?.kind === 'slug-climb');
  // A shared gym-board link is the same kind of arrival as a search result, so
  // it must not be the one that still hits the login wall. It carries no config
  // in the URL, so unlike the tuple form it does have to resolve — but by a
  // public read, with nothing minted and nothing stored.
  const anonymousSlug = anonymousClimbUrl && target?.kind === 'slug-climb' ? target.slug : null;
  const anonymousSlugBoard = useAnonymousSlugBoard(anonymousSlug);
  // An unresolved slug asks for a sign-in; it is never a dead end. The resolver
  // masks "you may not see this board" and "there is no such board" to the same
  // null, so a not-found here would tell a gym member their own board does not
  // exist — a REGRESSION on a URL that, before this branch existed, simply asked
  // them to sign in and then showed them the climb. Sign-in is also the only
  // move that resolves the ambiguity: signed in, the same URL either renders or
  // reaches the route's own not-found. A typo'd slug costs one login form, which
  // is what it cost yesterday.
  const anonymousClimb = anonymousClimbUrl && anonymousSlugBoard.state !== 'unresolved';
  const authRequired = signedOutOnWeb && !anonymousClimb;
  // Neither signed-out branch adopts. Adoption's first act is a CREATE_BOARD the
  // backend refuses without a session, and it is not a render input for either
  // one — so it is skipped rather than gated on the outcome.
  const { board: adoptedBoard, error: boardError } = useAdoptedBoard(target, adoptsBoard && !signedOutOnWeb);
  const anonymousBoard = anonymousSlugBoard.state === 'resolved' ? anonymousSlugBoard.board : null;
  const board = adoptedBoard ?? anonymousBoard;

  const wantsClimb = target?.kind === 'climb' || target?.kind === 'slug-climb';
  const climbUuid = wantsClimb ? target.climbUuid : undefined;

  // A tuple URL already carries the whole config, so its climb loads in parallel
  // with board adoption. A `/b/{slug}` URL carries none and has to wait for the
  // resolved board. One config feeds both the query and the drawer so the frames
  // the user sees can't drift from the ones we asked for.
  const configFromUrl = urlBoardConfig(target);
  // A `/b/{slug}/{angle}/…` URL's angle wins over the board's stored one; a
  // `/b/{slug}` URL carries none and the board's own angle is what the reader
  // lands on. The ADOPTED board already arrives with that applied —
  // `resolveBoardForSession` owns the rule for the signed-in path and the two
  // branches must not encode it twice — so this covers only the anonymous slug
  // read, which bypasses that resolver entirely.
  const anonymousUrlAngle = anonymousBoard && target?.kind === 'slug-climb' ? target.angle : null;
  const configFromBoard = useMemo<BoardConfig | null>(
    () =>
      board
        ? {
            boardName: board.boardType,
            layoutId: board.layoutId,
            sizeId: board.sizeId,
            setIds: board.setIds,
            angle: anonymousUrlAngle ?? board.angle,
          }
        : null,
    [board, anonymousUrlAngle],
  );
  const boardConfig = configFromUrl ?? configFromBoard;

  // `!authRequired` is what makes the short-circuit below true to its word: the
  // tuple form carries its whole config in the URL, so without this the climb
  // query would fire for a visitor we have already decided to send to login.
  const climbQuery = useClimb(!authRequired && boardConfig && climbUuid ? { ...boardConfig, climbUuid } : null);
  const climb = climbQuery.data;

  // Hand off exactly once per target. The ref guards a re-render firing the open
  // again after we've already navigated away — but it holds the target it fired
  // for rather than a bare flag, so a second URL arriving on the same mounted
  // screen still gets its hand-off instead of sitting on the spinner forever.
  const targetKey = target ? `${toBoardPath(target)}#${wantsClimb ? climbUuid : ''}` : null;
  const handedOffRef = useRef<string | null>(null);
  // The hand-off is reported imperatively, from inside the effect, rather than
  // through a status the caller could watch. It has to be: the same effect body
  // calls `router.replace` / `router.back`, React batches that with anything
  // else queued in the flush, and the navigator drops this screen in the very
  // render that would have carried the new status — the update is discarded with
  // the fiber and never commits. `join/[sessionId]` fires `Session Joined` the
  // same way, immediately before replacing itself. Held in a ref so a caller
  // passing a fresh closure each render can't re-enter the effect.
  const onHandedOffRef = useRef(options?.onHandedOff);
  useEffect(() => {
    onHandedOffRef.current = options?.onHandedOff;
  });
  useEffect(() => {
    if (!target || !targetKey || handedOffRef.current === targetKey) return;
    if (authRequired) return;
    // The anonymous climb renders where it stands. Handing off would navigate to
    // `/(tabs)/climbs` and then `/play`, both outside the read-only allow-set,
    // and `AuthProvider` re-reads `window.location.pathname` on every
    // navigation — so the drawer opening is exactly the moment the visitor gets
    // bounced back to the login wall this branch exists to remove.
    //
    // Ahead of the `!board` check below, not behind it. That check would happen
    // to stop a TUPLE climb (which resolves no board at all), but a slug climb
    // resolves one from the public read — so for `/b/{slug}/…` this line is the
    // only thing between an anonymous reader and a hand-off to `/play`.
    if (anonymousClimb) return;
    // A deep link has to land on the adopted board — the Climbs tab behind the
    // drawer renders whatever the active board is.
    if (adoptsBoard && !board) return;

    // How this screen gets out of the way decides the hand-off order below, and
    // it's a question about the HISTORY STACK, not about the mode: `in-app` only
    // pops because something pushed it. The legacy `climbs/[climbUuid]`
    // redirector is `in-app` and gets cold-opened directly — the expo-web
    // rollout 307s the whole cohort's numeric climb URLs straight at it — so it
    // has nothing behind it and must replace like a deep link. Asked before the
    // drawer opens, because opening navigates and would make `canGoBack` true.
    const canPop = !adoptsBoard && router.canGoBack();

    const leave = () => {
      if (canPop) {
        router.back();
        return;
      }
      router.replace(CLIMBS_TAB);
    };

    if (!wantsClimb) {
      handedOffRef.current = targetKey;
      onHandedOffRef.current?.();
      leave();
      return;
    }

    if (!climb || !boardConfig) return;
    handedOffRef.current = targetKey;
    onHandedOffRef.current?.();
    // preview:true so a deep-linked climb doesn't disturb the queue — in a
    // session it would change the shared current climb for everyone. The drawer
    // shows a "Preview" badge with "Set active" to opt into playing it.
    const openDrawer = () =>
      openClimbInPlayDrawer({ kind: 'climb', climb, boardConfig }, { openPlayDrawer, router }, { preview: true });

    // Order matters and follows `canPop`. `openPlayDrawer` navigates to `/play`,
    // so a screen that leaves by *replacing* itself must replace FIRST: replacing
    // after the open would replace `/play` itself, the drawer would never appear,
    // and the user would land on a bare Climbs tab. A screen that pops is the
    // mirror image — popping first would take the screen the drawer is meant to
    // return to with it — so it opens first.
    if (!canPop) {
      leave();
      openDrawer();
      return;
    }
    openDrawer();
    leave();
  }, [
    adoptsBoard,
    anonymousClimb,
    authRequired,
    board,
    boardConfig,
    climb,
    openPlayDrawer,
    router,
    target,
    targetKey,
    wantsClimb,
  ]);

  const status = resolveStatus({
    parsedUrl: target !== null,
    authRequired,
    boardError,
    // Only a settled query says the climb is gone: `isLoading` briefly reads
    // false in the render where the query switches on, which would flash a
    // not-found over a climb that is about to arrive.
    climbIsGone: wantsClimb && (climbQuery.isError || (climbQuery.isSuccess && !climb)),
    // The anonymous branch has nothing to draw until the climb lands, and
    // nowhere else to be meanwhile — so it sits on the spinner.
    anonymousClimbReady: anonymousClimb && climb != null && boardConfig != null,
  });

  // Only the slug branch resolves a board anonymously; a tuple URL has none, and
  // `true` is what `createBoard` would have stored for it anyway.
  const isAngleAdjustable = board?.isAngleAdjustable ?? true;

  return useMemo(
    () =>
      status === 'anonymous-climb'
        ? { status, climb: climb ?? null, boardConfig, isAngleAdjustable }
        : { status, climb: null, boardConfig: null, isAngleAdjustable: true },
    [status, climb, boardConfig, isAngleAdjustable],
  );
}
