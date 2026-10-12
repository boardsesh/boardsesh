import { useEffect, useMemo, useRef, useState } from 'react';
import { router, usePathname, useGlobalSearchParams, type Href } from 'expo-router';
import { DEFAULT_CLIMB_FILTER_STATE, toClimbSearchInput } from '@boardsesh/climb-filters';
import {
  buildScreenshotWallSeed,
  publishScreenshotWallClimbs,
  SCREENSHOT_WALL_SEED_COUNT,
} from '../lib/board-presence/screenshot-wall-seed';
import { useSearchClimbs } from '../lib/graphql/hooks';
import { useActiveBoard, useSetActiveBoard } from '../lib/graphql/use-active-board';
import { resolveScreenshotBoard } from '../lib/screenshot-board-selection';
import { resolveScreenshotCppBoard, type ScreenshotCppBoardIdentity } from '../lib/screenshot-cpp-board-identity';
import { useScreenshotBoards } from '../hooks/use-screenshot-boards';
import { useAuth } from '../providers/auth-provider';
import { SCREENSHOT_NOW_MS } from '../lib/screenshot-mode';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';

// Query-key placeholder for the frames before the active board resolves. The
// paired `enabled: false` means React Query never runs the fetch — the object
// is only hashed into the key — so the zero board values are never sent
// anywhere. Hoisted so every disabled render hashes the identical key.
const WALL_SEED_SEARCH_DISABLED_INPUT: ClimbSearchInput = {
  boardName: '',
  layoutId: 0,
  sizeId: 0,
  setIds: '',
  angle: 0,
  page: 0,
  pageSize: 0,
};

const CPP_CAPTURE_PARAM_KEYS = new Set([
  'screenshotCppScene',
  'screenshotBoardIndex',
  'screenshotOpenFirst',
  'screenshotClimbId',
  'screenshotMinGrade',
  'screenshotMaxGrade',
  'screenshotOpenFilters',
  'screenshotOpenWallPreview',
  'screenshotTab',
  'screenshotBoardType',
  'wallUuid',
]);

/** Diagnostic paths omit dynamic identifiers and unrecognized routes. */
function cppDiagnosticPathname(pathname: string): string {
  if (/^\/join\/[^/]+$/.test(pathname)) return '/join/[sessionId]';
  return [
    '/',
    '/home',
    '/climbs',
    '/climbs/create',
    '/profile',
    '/record',
    '/wall',
    '/discover/smart/PROJECTS',
    '/boards/spray/holds',
  ].includes(pathname)
    ? pathname
    : '[other route]';
}

/**
 * Screenshot builds only: make the board named by `SCREENSHOT_BOARDS[0]` active
 * so the board-backed screens (Climbs, Board View) render real content instead of
 * the "No board selected" picker. Replaces the Maestro flow's fragile
 * board-picker coordinate tap.
 *
 * Reactive + self-healing on purpose. It resolves the wall through React Query
 * and `useSetActiveBoard`, the same hook the real board picker uses — so it inherits React
 * Query's auth/retry/timing instead of a hand-rolled fetch wedged into the auth
 * boot sequence (which raced the token + the query cache GC and silently no-op'd).
 * Because it keeps `useActiveBoard` observed, the activated board is never
 * garbage-collected, and if anything clears it (e.g. a sign-out cleanup on a boot
 * AppState race) the effect re-runs and re-activates.
 *
 * Also publishes the wall-kiosk seed (the active board's first climbs) from
 * here, at the root, so the iPad "On the Wall" hero lights up even if the
 * Maestro flow never reaches the Climbs screen — its sidebar coordinate tap has
 * missed on the 11" iPad, which shipped a "WALL IS DARK" App Store shot. The
 * Climbs screen still re-publishes the same seed when it mounts (idempotent).
 *
 * Mount only behind an inlined `EXPO_PUBLIC_SCREENSHOT_MODE === '1'` check so it
 * dead-strips in normal builds and never runs for real users.
 */
export function ScreenshotBoardAutoActivator(): null {
  const { isAuthenticated } = useAuth();
  const { data: activeBoard, isPending: activeBoardPending } = useActiveBoard();
  const primaryBoardActivated = useRef(false);
  // Every board, not the board picker's first page: the wall is pinned by name
  // and one page tops out at the server's default 20. Keeping it observed also
  // keeps the roster warm in the React Query cache for the re-activation path.
  const screenshotBoards = useScreenshotBoards(isAuthenticated);
  const setActiveBoard = useSetActiveBoard();

  const cppSequence = useRef(-1);
  const pathname = usePathname();
  const routeParams = useGlobalSearchParams();
  const [cppPending, setCppPending] = useState<{ sequence: number; route: string } | null>(null);
  const cppAckDiagnostic = useRef<string | null>(null);
  useEffect(() => {
    if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE !== '1' || !cppPending || !process.env.EXPO_PUBLIC_SCREENSHOT_CPP_URL)
      return;
    const destination = new URL(cppPending.route, 'http://localhost');
    const mismatchedKeys = [...destination.searchParams.entries()]
      .filter(([key, expected]) => routeParams[key] !== expected)
      .map(([key]) => key);
    const pathnameMatches = pathname === destination.pathname;
    const diagnostic = JSON.stringify({
      sequence: cppPending.sequence,
      intendedPathname: cppDiagnosticPathname(destination.pathname),
      actualPathname: cppDiagnosticPathname(pathname),
      pathnameMatches,
      requestedParamsMatch: mismatchedKeys.length === 0,
      mismatchedCaptureParamKeys: mismatchedKeys.filter((key) => CPP_CAPTURE_PARAM_KEYS.has(key)),
    });
    if (cppAckDiagnostic.current !== diagnostic) {
      cppAckDiagnostic.current = diagnostic;
      console.log(`[screenshot] CPP ACK route ${diagnostic}`);
    }
    if (!pathnameMatches || mismatchedKeys.length > 0) return;
    void (async () => {
      try {
        console.log(`[screenshot] CPP ACK request start ${JSON.stringify({ sequence: cppPending.sequence })}`);
        const response = await fetch(
          `${process.env.EXPO_PUBLIC_SCREENSHOT_CPP_URL}/ack?sequence=${cppPending.sequence}`,
        );
        console.log(
          `[screenshot] CPP ACK response ${JSON.stringify({ sequence: cppPending.sequence, status: response.status })}`,
        );
      } catch (error) {
        const errorKind =
          error instanceof Error && error.name === 'AbortError'
            ? 'aborted'
            : error instanceof TypeError
              ? 'network'
              : 'request';
        console.log(`[screenshot] CPP ACK request ${JSON.stringify({ sequence: cppPending.sequence, errorKind })}`);
      }
    })();
  }, [cppPending, pathname, routeParams]);

  // CPP commands carry navigation only. The real roster, search queries and native
  // screens supply all content; polling is sequential and each command runs once.
  useEffect(() => {
    if (
      process.env.EXPO_PUBLIC_SCREENSHOT_MODE !== '1' ||
      !process.env.EXPO_PUBLIC_SCREENSHOT_CPP_URL ||
      !isAuthenticated ||
      !screenshotBoards.length
    )
      return;
    const endpoint = process.env.EXPO_PUBLIC_SCREENSHOT_CPP_URL;
    const configuration = JSON.parse(process.env.EXPO_PUBLIC_SCREENSHOT_CPP_COMMANDS ?? '{}') as Record<
      string,
      { selector: string; identity: ScreenshotCppBoardIdentity; route: string }
    >;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await fetch(`${endpoint}/command`);
        const command = (await response.json()) as { sequence?: number; scene?: string };
        if (
          stopped ||
          typeof command.sequence !== 'number' ||
          typeof command.scene !== 'string' ||
          command.sequence <= cppSequence.current
        )
          return;
        const scene = configuration[command.scene];
        if (!scene) {
          cppSequence.current = command.sequence;
          return;
        }
        const board = resolveScreenshotCppBoard(screenshotBoards, scene.selector, scene.identity);
        if (!board) throw new Error(`CPP verified identity is ambiguous or missing: ${scene.selector}`);
        const activated = await setActiveBoard(board, () => !stopped);
        if (stopped) return;
        if (!activated) throw new Error(`CPP verified board activation did not commit: ${scene.selector}`);
        cppSequence.current = command.sequence;
        console.log(`[screenshot] CPP command ${command.sequence} ${command.scene}: ${board.uuid}`);
        setCppPending({ sequence: command.sequence, route: scene.route });
        router.replace(scene.route as Href);
      } catch (error) {
        console.log(`[screenshot] WARN CPP navigation: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        if (!stopped)
          timer = setTimeout(() => {
            void poll();
          }, 500);
      }
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [isAuthenticated, screenshotBoards, setActiveBoard]);

  // Logged once at boot so a screenshot run's Metro-teed output says whether
  // relative timestamps are pinned (EXPO_PUBLIC_SCREENSHOT_NOW parsed) or
  // still reading the real wall clock — see lib/clock.ts.
  useEffect(() => {
    console.log(
      SCREENSHOT_NOW_MS !== null
        ? `[screenshot] clock: frozen at ${new Date(SCREENSHOT_NOW_MS).toISOString()}`
        : '[screenshot] clock: live',
    );
  }, []);

  useEffect(() => {
    if (!isAuthenticated || activeBoardPending) return;
    if (primaryBoardActivated.current && activeBoard) return;
    // Slot 0 of SCREENSHOT_BOARDS — the wall every board-backed shot but the
    // second board-view sits on. By name, not position: myBoards comes back
    // newest-owned-first, so `boards[0]` drifts as the account follows walls.
    const targetBoard = resolveScreenshotBoard(screenshotBoards, 0);
    if (!targetBoard) return;
    if (activeBoard?.uuid === targetBoard.uuid) {
      primaryBoardActivated.current = true;
      return;
    }
    // Logged so a screenshot run is debuggable from the Metro output the
    // orchestrator tees (a missing line means the boards fetch came back empty).
    console.log(`[screenshot] auto-activating board ${targetBoard.uuid} (${targetBoard.boardType})`);
    void setActiveBoard(targetBoard);
  }, [isAuthenticated, activeBoard, activeBoardPending, screenshotBoards, setActiveBoard]);

  // Same default-filter search the Climbs list runs, sized to the seed — so the
  // wall lights the same climbs the Climbs screen would publish.
  const wallSeedSearchInput = useMemo(() => {
    if (!activeBoard) return null;
    return toClimbSearchInput(
      DEFAULT_CLIMB_FILTER_STATE,
      {
        boardName: activeBoard.boardType,
        layoutId: activeBoard.layoutId,
        sizeId: activeBoard.sizeId,
        setIds: activeBoard.setIds ?? '',
        angle: activeBoard.angle ?? 0,
      },
      { page: 0, pageSize: SCREENSHOT_WALL_SEED_COUNT },
    );
  }, [activeBoard]);
  const { data: wallSeedSearch } = useSearchClimbs(
    wallSeedSearchInput ?? WALL_SEED_SEARCH_DISABLED_INPUT,
    wallSeedSearchInput !== null,
  );

  useEffect(() => {
    const seedClimbs = wallSeedSearch?.climbs;
    if (!activeBoard || !seedClimbs || seedClimbs.length === 0) return;
    // Logged for the same Metro-tee debuggability as the activation above.
    console.log(`[screenshot] wall seed published from auto-activator (${seedClimbs.length} climbs)`);
    publishScreenshotWallClimbs(
      buildScreenshotWallSeed(seedClimbs, activeBoard.angle ?? null, activeBoard),
      null,
      activeBoard.uuid,
    );
  }, [wallSeedSearch, activeBoard]);

  return null;
}
