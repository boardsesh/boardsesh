// Drives the native sign-in hand-off: open the OAuth page in an in-app browser
// and wait for the OS deep link that the server's callback page fires
// (com.boardsesh.app://auth/callback?transferToken=...). All platform I/O is
// injected so unit tests need no expo-web-browser or react-native mocks.
//
// Why not WebBrowser.openAuthSessionAsync: its ASWebAuthenticationSession can
// fail to present (observed as 100–250ms failures on iOS 26 devices — expo's
// presentation anchor is the deprecated UIApplication.shared.keyWindow), and
// expo-web-browser collapses every such failure into {type: 'cancel'},
// indistinguishable from the user closing the sheet. SFSafariViewController +
// an OS deep link is the same hand-off the legacy Capacitor app shipped with,
// and the server's deep-link callback page was built for it.

export type AuthSessionRaceResult =
  | { type: 'success'; url: string }
  | { type: 'cancel' }
  | { type: 'timeout' }
  | { type: 'error'; message: string };

type UrlEventSubscription = { remove: () => void };
type AppStateEventSubscription = { remove: () => void };
type TimerHandle = ReturnType<typeof setTimeout>;

export type AuthSessionAppState = 'active' | 'background' | 'inactive' | 'unknown' | 'extension';

const ANDROID_CALLBACK_GRACE_MS = 1_000;
const ANDROID_AUTH_DEADLINE_MS = 5 * 60_000;

export type AuthSessionRaceIo = {
  platform: 'ios' | 'android';
  addUrlListener: (listener: (event: { url: string }) => void) => UrlEventSubscription;
  addAppStateListener: (listener: (state: AuthSessionAppState) => void) => AppStateEventSubscription;
  getCurrentAppState: () => AuthSessionAppState | null;
  openBrowser: (url: string) => Promise<unknown>;
  dismissBrowser: () => Promise<unknown>;
  setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer: (timer: TimerHandle) => void;
};

function isOpenedBrowserResult(result: unknown): boolean {
  return typeof result === 'object' && result !== null && (result as { type?: unknown }).type === 'opened';
}

export function raceBrowserSignIn(
  io: AuthSessionRaceIo,
  authUrl: string,
  callbackUrlPrefix: string,
): Promise<AuthSessionRaceResult> {
  return new Promise((resolve) => {
    let urlSubscription: UrlEventSubscription | null = null;
    let appStateSubscription: AppStateEventSubscription | null = null;
    let authDeadlineTimer: TimerHandle | null = null;
    let callbackGraceTimer: TimerHandle | null = null;
    let settled = false;

    const clearCallbackGrace = () => {
      if (callbackGraceTimer === null) return;
      io.clearTimer(callbackGraceTimer);
      callbackGraceTimer = null;
    };

    const settle = (result: AuthSessionRaceResult) => {
      if (settled) return;
      settled = true;
      urlSubscription?.remove();
      appStateSubscription?.remove();
      if (authDeadlineTimer !== null) {
        io.clearTimer(authDeadlineTimer);
        authDeadlineTimer = null;
      }
      clearCallbackGrace();
      resolve(result);
    };

    urlSubscription = io.addUrlListener(({ url }) => {
      if (settled) return;
      if (!url.startsWith(callbackUrlPrefix)) return;
      // Close the browser left behind under the deep-link hand-off. Best-effort:
      // its own resolution below is a no-op once settled.
      io.dismissBrowser().catch(() => {});
      settle({ type: 'success', url });
    });

    // iOS openBrowser resolves only when its SFSafariViewController closes, so
    // preserve the original behavior exactly: the callback wins and dismisses;
    // any browser resolution is a cancel; a rejection means it could not open.
    // Android's AppState/timer completion rules must never affect this branch.
    if (io.platform === 'ios') {
      io.openBrowser(authUrl).then(
        () => settle({ type: 'cancel' }),
        (openBrowserError: unknown) =>
          settle({
            type: 'error',
            message: openBrowserError instanceof Error ? openBrowserError.message : 'browser failed to open',
          }),
      );
      return;
    }

    let backgroundObserved = false;
    let deadlineExpired = false;
    let deadlineWaitingForActive = false;

    const startCallbackGrace = (result: AuthSessionRaceResult) => {
      if (settled) return;
      clearCallbackGrace();
      callbackGraceTimer = io.setTimer(() => settle(result), ANDROID_CALLBACK_GRACE_MS);
    };

    // Android returns {type: 'opened'} as soon as the Custom Tab launches. The
    // only reliable close signal is the app actually leaving and later becoming
    // active, so a lone/initial active event is deliberately ignored.
    appStateSubscription = io.addAppStateListener((nextAppState) => {
      if (settled) return;
      if (nextAppState === 'background') {
        backgroundObserved = true;
        deadlineWaitingForActive = deadlineExpired;
        clearCallbackGrace();
        return;
      }
      if (nextAppState !== 'active') return;

      if (deadlineWaitingForActive) {
        deadlineWaitingForActive = false;
        backgroundObserved = false;
        startCallbackGrace({ type: 'timeout' });
        return;
      }
      if (!backgroundObserved) return;

      backgroundObserved = false;
      startCallbackGrace(deadlineExpired ? { type: 'timeout' } : { type: 'cancel' });
    });

    authDeadlineTimer = io.setTimer(() => {
      if (settled) return;
      deadlineExpired = true;
      if (io.getCurrentAppState() === 'background' || backgroundObserved) {
        deadlineWaitingForActive = true;
        clearCallbackGrace();
        return;
      }
      // Linking delivery may follow the foreground/deadline signal. Keep the URL
      // listener alive for one final turn before reporting the distinct timeout.
      startCallbackGrace({ type: 'timeout' });
    }, ANDROID_AUTH_DEADLINE_MS);

    io.openBrowser(authUrl).then(
      (browserResult) => {
        // Android resolves with `opened` immediately after launching the tab;
        // every other/unknown resolution is terminal so a future SDK result
        // cannot leave the race hanging forever.
        if (!isOpenedBrowserResult(browserResult)) settle({ type: 'cancel' });
      },
      (openBrowserError: unknown) =>
        settle({
          type: 'error',
          message: openBrowserError instanceof Error ? openBrowserError.message : 'browser failed to open',
        }),
    );
  });
}
