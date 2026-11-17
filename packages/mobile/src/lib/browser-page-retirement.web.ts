/**
 * One account per browser page (#7596). The first signed-in identity a page
 * confirms is latched. A later confirmed identity that differs from it, or a
 * confirmed sign-out, retires the page for good: the transport refuses new
 * sends and drops responses, the socket is disposed, the auth provider runs the
 * old owner's cleanup and then reloads from the app root. Only that reload
 * clears the latch. Signing in on a page that never had an account latches the
 * new one and does not retire anything.
 */
type PageIdentity = Readonly<{ userId: string; authSessionId: string }>;

let pageIdentity: PageIdentity | null = null;
let retired = false;
let reloadStarted = false;
const retirementListeners = new Set<() => void>();

function retire(): void {
  if (retired) return;
  retired = true;
  for (const listener of Array.from(retirementListeners)) {
    try {
      listener();
    } catch {
      // Every transport must learn about retirement even when one listener throws.
    }
  }
}

/** Record a confirmed session read: `null` is a confirmed signed-out cookie. */
export function observeConfirmedBrowserIdentity(identity: PageIdentity | null): void {
  if (retired) return;
  if (pageIdentity === null) {
    if (identity !== null) pageIdentity = { userId: identity.userId, authSessionId: identity.authSessionId };
    return;
  }
  if (identity && identity.userId === pageIdentity.userId && identity.authSessionId === pageIdentity.authSessionId)
    return;
  retire();
}

/** A confirmed sign-out of this page's account. A page that never had one has nothing to retire. */
export function retireBrowserPageForSignOut(): void {
  if (pageIdentity !== null) retire();
}

export function hasBrowserPageIdentity(): boolean {
  return pageIdentity !== null;
}

export function isBrowserPageRetired(): boolean {
  return retired;
}

export function subscribeBrowserPageRetired(listener: () => void): () => void {
  retirementListeners.add(listener);
  return () => retirementListeners.delete(listener);
}

/** `/app` on the www-mounted export, `/` on app.boardsesh.com (same derivation as auth.web.ts). */
export function reloadRetiredBrowserPage(): void {
  if (reloadStarted || typeof window === 'undefined') return;
  reloadStarted = true;
  // replace, not assign: the retired document must not stay in history, where
  // Back could restore the old account's tree.
  window.location.replace(new URL(process.env.EXPO_BASE_URL || '/', window.location.origin).toString());
}

/** Module-level transport subscriptions stay registered; only the latch resets. */
export function resetBrowserPageRetirementForTests(): void {
  pageIdentity = null;
  retired = false;
  reloadStarted = false;
}
