import type { Climb } from '@boardsesh/shared-schema';
import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import type { ReadyBoardArtSnapshot } from '../../lib/board-render/ready-board-art';
import type { DismissSurfaceAndWait } from '../create-climb/use-create-climb-navigation';
import type { SwipeDismissAnimation } from './use-drawer-dismiss-gesture';

// Matches DrawerHostProvider's string-backed route/preview configuration and
// override callback contracts. Keep that existing boundary here; narrowing the
// whole drawer contract would span its hosts and cross-board preview resolution.
export type BoardConfig = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
};

export type PlayDrawerOpenOptions = {
  /** Already displayed art for this exact target; never changes queue semantics. */
  readyBoardArt?: ReadyBoardArtSnapshot;
  /**
   * The caller already dispatched `setCurrentClimb` for this climb (the
   * drawer-host queue / suggestion / board-sheet taps and playlist activation
   * do this). The drawer renders from `currentClimbQueueItem` and skips its own
   * commit so the item isn't dispatched twice. No browse latch — the shown climb
   * IS the active climb, so the header pill and the commit row stay stood down.
   */
  committedExternally?: boolean;
  /**
   * View-only preview: show this item in the drawer WITHOUT committing it to the
   * queue. This is the browse latch — the header pill reads "Browsing", the board
   * wears the viewfinder brackets, and the action bar's second row swaps to
   * "Back to live" + "Put on the wall". Used by the explicit "Preview" climb
   * action, the deep-link / standalone climb-page route, the workout builder, and
   * the peer-driven wall climb behind the accessory bar. The lightbulb keeps
   * acting on the active climb, not this preview.
   */
  previewQueueItem?: ClimbQueueItem | null;
  /**
   * The preview is the live wall climb behind the accessory bar — a peer (or
   * another climber on this board) is driving the wall and this climb is lit
   * right now. The pill then reads "On the wall" (the displayed climb IS the lit
   * one) and there's nothing to commit, so only "Back to live" remains. Only
   * meaningful alongside `previewQueueItem`.
   */
  previewIsWallClimb?: boolean;
  /**
   * Playlist source that seeds the drawer's next/previous suggestions for a
   * preview open (the suggestion source isn't on the queue yet). Drives
   * swipe-through-playlist in the drawer without re-dispatching.
   */
  playlistSuggestionSource?: PlaylistSuggestionSource | null;
};

/**
 * The climb the route wants the player to show. `nonce` is bumped by the host on
 * every open request so this re-applies even when navigation is a no-op (the user
 * re-tapping a climb while the player route is already mounted).
 */
export type PlayDrawerOpenTarget = {
  climb: Climb;
  options?: PlayDrawerOpenOptions;
  nonce: number;
};

export type PlayDrawerProps = {
  /** `/play` owns the transform so its backing and content travel together. */
  swipeDismiss?: SwipeDismissAnimation;
  onClose?: () => void;
  boardConfig: BoardConfig;
  onAngleChange?: (angle: number) => void;
  /** When false, the board's angle is fixed — the angle pill is hidden. */
  isAngleAdjustable?: boolean;
  /** Open the queue list sheet (the route hosts its own QueueSheet instance so it
   *  stacks above the player; passed as a prop rather than read via useDrawerHost,
   *  which would target the host's closed-player instance). */
  onOpenQueue: () => void;
  /** When true, the displayed climb belongs to a board other than the user's
   *  active board — render the switch-board overlay over the controls. */
  boardMismatch?: boolean;
  /**
   * Board models standing at the same gym as the active board. A climb on one of
   * them gets the "move to that board" invitation instead of the lock scrim.
   * Omit it and every board-foreign climb keeps blocking, exactly as before.
   */
  reachableBoardKeys?: ReadonlySet<string>;
  /** Human-readable name of the climb's board, shown in the overlay message. */
  mismatchBoardLabel?: string;
  /** Switch to the climb's board (one-tap if owned, else the board picker). The
   *  drawer passes the board it resolved for the displayed climb when the
   *  mismatch was discovered from the climb rather than handed in as an
   *  override — the host has no override to read in that case. */
  onSwitchBoard?: (boardConfig?: BoardConfig) => void;
  /** Supplied only by the `/play` route. The persistent iPad pane omits it. */
  dismissPlayerAndWait?: DismissSurfaceAndWait;
  /** The climb to show; applied on mount and whenever `nonce` changes. */
  openTarget: PlayDrawerOpenTarget | null;
  /** Rendering context. `'route'` (default) is the full-screen `/play` modal — a
   *  pull-down gesture + the close chevron dismiss it. `'pane'` is the persistent
   *  iPad right-column pane: it's always on screen, so the dismiss gesture, the
   *  close chevron, and the grabber are all suppressed and `router.dismiss()` is
   *  never called. */
  presentation?: 'route' | 'pane';
  /** Pane mode only: include the top safe-area inset above the first screen. False
   *  when a WallStrip is docked above the pane and already owns that inset. Ignored
   *  in route mode (the modal always owns the top inset). */
  paneTopInset?: boolean;
  /**
   * Who is looking. `'anonymous'` is the signed-out reader that
   * `AnonymousClimbView` renders on the web export's read-only climb URL: the
   * board, header, grade and every below-fold read stay, and every write
   * affordance is removed (see PlayDrawerActionBar's `viewer` prop for the full
   * list and why removal beats disabling). Never reachable on native — the whole
   * anonymous branch sits behind `RELAXES_ANONYMOUS_ROUTES`, a literal `false`
   * in the native fork.
   */
  viewer?: 'member' | 'anonymous';
  /** Anonymous only: hand this URL to login. Wired to the tick prompt. */
  onSignIn?: () => void;
};
