// "Sign in" from any screen, without stacking the sign-in screen as a card on
// a modal. `auth` is a root route with no `presentation`, and expo-router
// presents such a route as a modal whenever a modal sits under it
// (getModalRouteKeys, expo-router 58), so pushed from inside the board picker
// (a root `presentation: 'modal'`) it became a second page sheet on iOS, with
// its swipe turned off. From inside the picker the sign-in screen REPLACES the
// picker instead: `dismissTo` pops to it, and with no `auth` below it pops the
// picker and puts sign-in in its place (StackRouter's POP_TO), so it opens as
// the full-screen card it is from the tabs. Everywhere else it is the plain
// push it always was.
//
// Why not `presentation: 'transparentModal'` on the root `auth` screen: it
// would change every sign-in in the app, the session-expiry redirect included,
// for a path that is rare. Today none is reachable on native at all:
// AuthProvider renders a <Redirect href="/auth/login"> in place of the whole
// app whenever the climber is signed out outside /auth, so a signed-out
// picker never draws. These are its last line of defence, not its front door.
//
// After signing in there is no way back to the picker on native (AuthProvider
// sends a fresh sign-in to the app's entry; `?next=` is web only), which is
// the same place the redirect above lands.

import type { ImperativeRouter } from 'expo-router';

export const SIGN_IN_HREF = '/auth/login';

/**
 * Opens sign-in from a screen in `stack`: the board picker's modal stack
 * (`boards`), or anywhere else (`root`).
 */
export function openSignIn(router: Pick<ImperativeRouter, 'push' | 'dismissTo'>, stack: 'boards' | 'root'): void {
  if (stack === 'boards') router.dismissTo(SIGN_IN_HREF);
  else router.push(SIGN_IN_HREF);
}
