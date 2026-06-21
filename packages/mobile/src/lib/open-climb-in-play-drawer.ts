import { type useRouter } from 'expo-router';
import type { Climb } from '@boardsesh/shared-schema';
import type { BoardConfig, OpenPlayDrawerOptions } from '../providers/drawer-host-provider';
import { climbToQueueItem } from './climb-to-queue-item';
import { getBoardConfigForPlaylist } from './playlists/board-details-for-playlist';
import { tickToClimb, type TickLike } from './tick-to-climb';

type Router = ReturnType<typeof useRouter>;

type OpenPlayDrawer = (climb: Climb, options?: OpenPlayDrawerOptions) => void;

export type OpenClimbDeps = {
  openPlayDrawer: OpenPlayDrawer;
  router: Pick<Router, 'push'>;
};

/**
 * The ways a climb is referenced across the app:
 * - `climb`: a fully-loaded climb + its board config (open the drawer directly).
 * - `tick`: a session tick highlight (build the climb from its frames).
 * - `ref`: only a uuid + board params (no frames) — open via the climb route,
 *   which loads the full climb by uuid and then hands off to the play drawer.
 */
export type OpenClimbArgs =
  | { kind: 'climb'; climb: Climb; boardConfig: BoardConfig }
  | { kind: 'tick'; tick: TickLike }
  | {
      kind: 'ref';
      climbUuid: string;
      boardType: string;
      layoutId?: number | null;
      angle: number;
      /** Optional precise size/sets; resolved from `getBoardConfigForPlaylist`
       *  when absent (e.g. the beta shelf only carries board type + layout). */
      sizeId?: number;
      setIds?: string;
    };

export type OpenClimbOptions = {
  /**
   * When `true`, the climb opens **view-only**: the drawer shows it with a
   * "Preview" badge + a "Set active" button and leaves the queue untouched.
   * Defaults to `false` — the climb is set as the current climb (and appended to
   * the queue), so pressing a climb plays it. Used by the explicit "Preview"
   * climb action and the deep-link / standalone climb-page route. Ignored on the
   * `ref` fallback, which routes through the climb page and opens with its own
   * default.
   */
  preview?: boolean;
};

/**
 * Build the play-drawer open options for a climb that is either activated
 * (commit) or shown view-only (preview). A preview anchors navigation on a fresh
 * queue item without committing it; an active open lets the drawer commit.
 */
function openModeOptions(climb: Climb, preview: boolean): Pick<OpenPlayDrawerOptions, 'previewQueueItem'> {
  return preview ? { previewQueueItem: climbToQueueItem(climb) } : {};
}

/**
 * The single entry point for opening a climb anywhere in the app. Every former
 * caller of the standalone climb page routes through here so all climb viewing
 * flows through the play drawer.
 *
 * Plain function (not a hook) so it's callable from `useCallback` bodies — pass
 * the host's `openPlayDrawer` and the screen's `router` as deps.
 */
export function openClimbInPlayDrawer(args: OpenClimbArgs, deps: OpenClimbDeps, options?: OpenClimbOptions): void {
  const { openPlayDrawer, router } = deps;
  const preview = options?.preview ?? false;

  if (args.kind === 'climb') {
    openPlayDrawer(args.climb, {
      ...openModeOptions(args.climb, preview),
      boardConfig: args.boardConfig,
      source: 'climb_view',
    });
    return;
  }

  if (args.kind === 'tick') {
    const climb = tickToClimb(args.tick);
    const config = getBoardConfigForPlaylist(args.tick.boardType, args.tick.layoutId);
    if (climb && config) {
      openPlayDrawer(climb, {
        ...openModeOptions(climb, preview),
        boardConfig: {
          boardName: config.boardName,
          layoutId: config.layoutId,
          sizeId: config.sizeId,
          setIds: config.setIds.join(','),
          angle: args.tick.angle,
        },
        source: 'climb_view',
      });
      return;
    }
    // No frames (can't build the climb) or an unresolvable board (e.g. MoonBoard):
    // fall back to the climb route, which loads the full climb by uuid. When the
    // board itself can't resolve, the ref branch also no-ops — matching the prior
    // navigate-helpers that returned early for MoonBoard.
    openClimbInPlayDrawer(
      {
        kind: 'ref',
        climbUuid: args.tick.climbUuid,
        boardType: args.tick.boardType,
        layoutId: args.tick.layoutId,
        angle: args.tick.angle,
      },
      deps,
    );
    return;
  }

  // kind: 'ref'
  let { sizeId, setIds } = args;
  let boardName = args.boardType;
  let layoutId = args.layoutId ?? null;
  if (sizeId == null || setIds == null) {
    const config = getBoardConfigForPlaylist(args.boardType, args.layoutId);
    if (!config) return; // unresolvable board → no-op (preserves prior behaviour)
    boardName = config.boardName;
    layoutId = config.layoutId;
    sizeId = config.sizeId;
    setIds = config.setIds.join(',');
  }
  if (layoutId == null) return;
  router.push({
    pathname: '/(tabs)/climbs/[climbUuid]',
    params: {
      climbUuid: args.climbUuid,
      boardName,
      layoutId: String(layoutId),
      sizeId: String(sizeId),
      setIds,
      angle: String(args.angle),
    },
  });
}
