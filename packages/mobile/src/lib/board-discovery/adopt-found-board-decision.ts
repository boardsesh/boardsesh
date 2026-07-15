// Pure decision for what "adopting" a board found in discovery entails. Kept
// renderer/hook-free so it can be unit-tested without the GraphQL/offline plumbing.

export type AdoptOfflineAction = 'auto' | 'ask' | 'none';

export type AdoptDecision = {
  /** Follow the board server-side so it lands in My Boards. */
  follow: boolean;
  /** What to do about offline availability. */
  offline: AdoptOfflineAction;
};

export type AdoptFoundBoardParams = {
  /** Viewer owns this board. */
  isOwned: boolean;
  /** Viewer already follows this board. */
  isFollowedByMe: boolean;
  /** The `offline-board-downloads` feature flag is on. */
  offlineEnabled: boolean;
  /** The user's "keep all boards offline by default" setting. */
  autoOffline: boolean;
  /** This board's scope is already in `syncEnabledBoards`. */
  alreadyEnabledOffline: boolean;
};

/**
 * Decide what adopting a found board means: follow it when it's genuinely new to
 * the user, and — when offline downloads are available — either auto-download it
 * (global default on), ask the user, or do nothing.
 *
 * The offline offer only *asks* for freshly-found boards. Re-selecting a board you
 * already own/follow never nags; a global auto-offline default still silently
 * ensures any not-yet-enabled board gets downloaded.
 */
export function decideAdoptFoundBoard({
  isOwned,
  isFollowedByMe,
  offlineEnabled,
  autoOffline,
  alreadyEnabledOffline,
}: AdoptFoundBoardParams): AdoptDecision {
  const isNew = !isOwned && !isFollowedByMe;
  const follow = isNew;

  if (!offlineEnabled || alreadyEnabledOffline) return { follow, offline: 'none' };
  if (autoOffline) return { follow, offline: 'auto' };
  return { follow, offline: isNew ? 'ask' : 'none' };
}
