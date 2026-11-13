// Drives the iOS sign-in hand-off: open the OAuth page in an in-app browser
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
  | { type: 'error'; message: string };

type UrlEventSubscription = { remove: () => void };

export type AuthSessionRaceIo = {
  addUrlListener: (listener: (event: { url: string }) => void) => UrlEventSubscription;
  openBrowser: (url: string) => Promise<unknown>;
  dismissBrowser: () => Promise<unknown>;
};

export function raceBrowserSignIn(
  io: AuthSessionRaceIo,
  authUrl: string,
  callbackUrlPrefix: string,
): Promise<AuthSessionRaceResult> {
  return new Promise((resolve) => {
    let subscription: UrlEventSubscription | null = null;
    let settled = false;
    const settle = (result: AuthSessionRaceResult) => {
      if (settled) return;
      settled = true;
      subscription?.remove();
      resolve(result);
    };

    subscription = io.addUrlListener(({ url }) => {
      if (!url.startsWith(callbackUrlPrefix)) return;
      // Close the browser left behind under the deep-link hand-off. Best-effort:
      // its own resolution below is a no-op once settled.
      io.dismissBrowser().catch(() => {});
      settle({ type: 'success', url });
    });

    io.openBrowser(authUrl).then(
      // Resolves when the browser closes. Reaching this un-settled means no
      // callback deep link arrived — the user closed it without finishing.
      () => settle({ type: 'cancel' }),
      (openBrowserError: unknown) =>
        settle({
          type: 'error',
          message: openBrowserError instanceof Error ? openBrowserError.message : 'browser failed to open',
        }),
    );
  });
}
