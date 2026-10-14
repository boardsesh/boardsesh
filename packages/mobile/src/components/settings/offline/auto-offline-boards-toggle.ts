/** What the "Keep boards offline" switch touches, injected so the handler is testable. */
export type AutoOfflineBoardsToggleDeps = {
  /**
   * The "Downloading N boards" toast copy. Resolved by the screen, where `t` is
   * bound, so the i18n orphan scanner can see the key being used.
   */
  downloadingMessage: (boardCount: number) => string;
  /** Persists the setting. The settings layout's `useKeepBoardsOffline` does the downloading. */
  setAutoOfflineBoards: (enabled: boolean) => void;
  /** How many boards in My Boards are not downloaded yet, read at the tap. */
  missingBoardCount: () => number;
  /** Hands this tap's attribution to the download effect (issue #4316). */
  rememberDownloadAllTap: () => void;
  /** Drops an attribution that was never spent. */
  forgetDownloadAllTap: () => void;
  trackDownloadAllTapped: (properties: { boardCount: number; offlineEngineEnabled: boolean }) => void;
  isOfflineEngineEnabled: () => boolean;
  showToast: (message: string) => void;
};

/**
 * The "Keep boards offline" switch handler.
 *
 * Turning it on downloads every board already in My Boards. The download itself
 * is `useKeepBoardsOffline`, mounted once by the settings layout (robust to a
 * not-yet-loaded list); this persists the switch, files the tap, and says how
 * many boards will download.
 */
export function makeAutoOfflineBoardsToggle(deps: AutoOfflineBoardsToggleDeps): (enabled: boolean) => void {
  return (enabled) => {
    deps.setAutoOfflineBoards(enabled);
    if (!enabled) {
      // Switched back off before the list ever resolved: the tap is spent, and
      // leaving it armed would attribute a later automatic enable to it.
      deps.forgetDownloadAllTap();
      return;
    }
    const boardCount = deps.missingBoardCount();
    // Fired HERE, on the real tap, and once per tap rather than once per board.
    // The effect is a mount-time reaction to the persisted setting, so firing a
    // "…Tapped" event from it would assert a tap that never happened.
    deps.rememberDownloadAllTap();
    deps.trackDownloadAllTapped({ boardCount, offlineEngineEnabled: deps.isOfflineEngineEnabled() });
    // Nothing to say when every board is already on the phone.
    if (boardCount > 0) deps.showToast(deps.downloadingMessage(boardCount));
  };
}
