import type { ClimbQueueItem } from '@boardsesh/queue';

/** Which sub-drawer is currently open inside the play view. */
export type ActiveSubDrawer = 'none' | 'queue' | 'playlist' | 'lightControl' | 'angleSelector';

/** Core state for the play view drawer. */
export type PlayDrawerState = {
  activeSubDrawer: ActiveSubDrawer;
  isTickBarActive: boolean;
  isBoardZoomed: boolean;
};

/** How the play drawer was opened. */
export type PlayDrawerEntry =
  | { source: 'list'; climb: ClimbQueueItem }
  | { source: 'queue'; item: ClimbQueueItem }
  | { source: 'deepLink'; climbUuid: string };

/** Platform-agnostic action bar props contract (no React elements or platform-specific types). */
export type ActionBarContract = {
  canSwipePrevious: boolean;
  canSwipeNext: boolean;
  isMirrored: boolean;
  supportsMirroring: boolean;
  isFavorited: boolean;
  remainingQueueCount: number;
  lightbulbActive: boolean;
  lightbulbPending?: boolean;
  onPrevClick: () => void;
  onNextClick: () => void;
  onMirror: () => void;
  onToggleFavorite: () => void;
  onLightbulb: () => void;
  onOpenActions: () => void;
  onOpenQueue: () => void;
};

/** Result of computing navigation state from queue. */
export type NavigationState = {
  canNext: boolean;
  canPrevious: boolean;
  nextItem: ClimbQueueItem | null;
  prevItem: ClimbQueueItem | null;
  /**
   * How many climbs after the current one a forward swipe can still visit. With
   * an active board supplied this excludes queued climbs that board cannot draw,
   * so "N left" counts swipes rather than rows. Board-blind callers get the
   * plain remaining count they always had.
   */
  remainingCount: number;
  /**
   * True when Next has nothing to go to because the climb on screen is the last
   * one on the list the player is walking (issue #6664). Tells "end of the list"
   * apart from "nothing to walk": the player offers its end card for the first
   * and nothing for the second.
   */
  atTrackEnd: boolean;
};
