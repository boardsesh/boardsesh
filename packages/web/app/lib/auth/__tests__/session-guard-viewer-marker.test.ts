// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createSessionGuard, isSessionSuperseded, signedInViewer, type SessionGuard } from '../session-guard';

/**
 * The viewer marker in www's guard (#7596 decision, "how the guard learns of an
 * account switch on another host"): a reply that lands under another login's
 * marker is held for the session check, and the toast/navigation gate reads
 * the same marker.
 */

const MARKER_NAME = '__Secure-boardsesh.viewer';
const accountA = { userId: 'user-a', authSessionId: 'login-a' };
const accountB = { userId: 'user-b', authSessionId: 'login-b' };
const markerOf = (authSessionId: string) => `marker-${authSessionId}`.padEnd(16, '0').slice(0, 16);

let documentCookie: string;
let clock: number;
let reloadPage: ReturnType<typeof vi.fn<() => void>>;
let requestSessionCheck: ReturnType<typeof vi.fn<() => void>>;
let guard: SessionGuard;

const setMarker = (value: string | undefined) => {
  documentCookie = value === undefined ? 'other=1' : `other=1; ${MARKER_NAME}=${value}`;
};

/** A reply the server already answered; it lands when the guard lets it. */
const send: typeof fetch = async () => new Response('{"ok":true}', { status: 200 });

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Signs the guard in as `viewer` and waits for its marker digest. */
async function signedInAs(viewer: { userId: string; authSessionId: string }) {
  expect(guard.accept(viewer)).toBe('publish');
  await settle();
}

/** Signs in as `viewer` with its own marker in the browser, as a login under `better-auth` writes it: armed. */
async function armedAs(viewer: { userId: string; authSessionId: string }) {
  setMarker(markerOf(viewer.authSessionId));
  await signedInAs(viewer);
}

/** Starts a reply and reports whether it settled by now, and how. */
function landing() {
  const outcome: { state: 'pending' | 'delivered' | 'superseded' | 'failed' } = { state: 'pending' };
  const promise = guard.fetch('https://www.boardsesh.com/api/internal/profile').then(
    () => {
      outcome.state = 'delivered';
    },
    (error: unknown) => {
      outcome.state = isSessionSuperseded(error) ? 'superseded' : 'failed';
    },
  );
  return { outcome, promise };
}

beforeEach(() => {
  setMarker(undefined);
  clock = 1_000_000;
  reloadPage = vi.fn<() => void>();
  requestSessionCheck = vi.fn<() => void>();
  guard = createSessionGuard({
    reloadPage,
    requestSessionCheck,
    send,
    cleanupTimeoutMs: 10,
    pageOrigin: () => 'https://www.boardsesh.com',
    readDocumentCookie: () => documentCookie,
    secureContext: () => true,
    computeMarker: async (authSessionId) => markerOf(authSessionId),
    now: () => clock,
  });
});

describe('viewer marker in guardedFetch', () => {
  it('delivers a reply under the page’s own marker and checks nothing', async () => {
    await signedInAs(accountA);
    setMarker(markerOf(accountA.authSessionId));
    const reply = landing();
    await reply.promise;
    expect(reply.outcome.state).toBe('delivered');
    expect(requestSessionCheck).not.toHaveBeenCalled();
  });

  it('holds a reply under B’s marker; the check names B, so it is superseded and the page retires', async () => {
    await armedAs(accountA);
    setMarker(markerOf(accountB.authSessionId));
    const started = guard.sessionReadStarted();
    const reply = landing();
    await settle();
    expect(reply.outcome.state).toBe('pending');
    expect(requestSessionCheck).toHaveBeenCalledTimes(1);
    // No toast or navigation while it is held.
    expect(guard.isCurrent(guard.capture())).toBe(false);

    expect(guard.accept(accountB, started + 1)).toBe('retire');
    await reply.promise;
    expect(reply.outcome.state).toBe('superseded');
    await vi.waitFor(() => expect(reloadPage).toHaveBeenCalledTimes(1));
  });

  it('delivers a held reply when the check confirms the same login, and checks that value only once', async () => {
    await armedAs(accountA);
    setMarker('tossed-value-001');
    const first = landing();
    await settle();
    expect(first.outcome.state).toBe('pending');
    guard.sessionChecked(guard.sessionReadStarted(), true);
    await first.promise;
    expect(first.outcome.state).toBe('delivered');

    const second = landing();
    await second.promise;
    expect(second.outcome.state).toBe('delivered');
    expect(requestSessionCheck).toHaveBeenCalledTimes(1);
    expect(guard.isCurrent(guard.capture())).toBe(true);
    expect(reloadPage).not.toHaveBeenCalled();
  });

  it('a session read finding the same login also confirms it', async () => {
    await armedAs(accountA);
    setMarker('tossed-value-002');
    const started = guard.sessionReadStarted();
    const reply = landing();
    await settle();
    expect(guard.accept(accountA, started + 1)).toBe('publish');
    await reply.promise;
    expect(reply.outcome.state).toBe('delivered');
  });

  it('supersedes the held reply when the check proves nothing, and delivers later ones under that value', async () => {
    await armedAs(accountA);
    setMarker('outage-value-003');
    const held = landing();
    await settle();
    guard.sessionChecked(guard.sessionReadStarted(), false);
    await held.promise;
    expect(held.outcome.state).toBe('superseded');

    const later = landing();
    await later.promise;
    expect(later.outcome.state).toBe('delivered');
    expect(requestSessionCheck).toHaveBeenCalledTimes(1);
    expect(reloadPage).not.toHaveBeenCalled();
  });

  it('treats a marker never seen as unknown: delivered, nothing checked', async () => {
    await signedInAs(accountA);
    setMarker(undefined);
    const reply = landing();
    await reply.promise;
    expect(reply.outcome.state).toBe('delivered');
    expect(requestSessionCheck).not.toHaveBeenCalled();
  });

  it('treats its own marker gone after it was seen as a mismatch (a sign-out on another host)', async () => {
    await signedInAs(accountA);
    setMarker(markerOf(accountA.authSessionId));
    await landing().promise;
    setMarker(undefined);
    const started = guard.sessionReadStarted();
    const reply = landing();
    await settle();
    expect(reply.outcome.state).toBe('pending');
    expect(requestSessionCheck).toHaveBeenCalledTimes(1);
    expect(guard.accept(null, started + 1)).toBe('retire');
    await reply.promise;
    expect(reply.outcome.state).toBe('superseded');
  });

  it('treats two differing copies as unknown before the page saw its own marker', async () => {
    await signedInAs(accountA);
    documentCookie = `${MARKER_NAME}=${markerOf(accountA.authSessionId)}; ${MARKER_NAME}=${markerOf(accountB.authSessionId)}`;
    await landing().promise;
    expect(requestSessionCheck).not.toHaveBeenCalled();
  });

  it('treats two differing copies as one false value once armed: one check, then delivered', async () => {
    await armedAs(accountA);
    // A copy at another Path or in another scope survives every clear, which reach Path=/ only.
    documentCookie = `${MARKER_NAME}=${markerOf(accountA.authSessionId)}; ${MARKER_NAME}=tossed-copy-0001`;
    const held = landing();
    await settle();
    expect(held.outcome.state).toBe('pending');
    guard.sessionChecked(guard.sessionReadStarted(), true);
    await held.promise;
    expect(held.outcome.state).toBe('delivered');
    await landing().promise;
    expect(requestSessionCheck).toHaveBeenCalledTimes(1);
  });

  it('with the mode off no marker is ever written: a planted one of any value is ignored, no check, no hold', async () => {
    await signedInAs(accountA);
    for (const planted of [markerOf(accountB.authSessionId), 'tossed-value-xyz', '']) {
      setMarker(planted);
      expect(guard.isCurrent(guard.capture())).toBe(true);
      const reply = landing();
      await reply.promise;
      expect(reply.outcome.state).toBe('delivered');
    }
    expect(requestSessionCheck).not.toHaveBeenCalled();
  });

  it('tries a check that proved nothing again on a later reply, after a backoff', async () => {
    await armedAs(accountA);
    setMarker(markerOf(accountB.authSessionId));
    const first = landing();
    await settle();
    guard.sessionChecked(guard.sessionReadStarted(), false);
    await first.promise;
    expect(first.outcome.state).toBe('superseded');
    // Inside the backoff: delivered as before the marker, no second check.
    clock += 29_000;
    await landing().promise;
    expect(requestSessionCheck).toHaveBeenCalledTimes(1);
    // After it: the next reply is held for a new check, which now names B.
    clock += 2_000;
    const started = guard.sessionReadStarted();
    const second = landing();
    await settle();
    expect(second.outcome.state).toBe('pending');
    expect(requestSessionCheck).toHaveBeenCalledTimes(2);
    expect(guard.accept(accountB, started + 1)).toBe('retire');
    await second.promise;
    expect(second.outcome.state).toBe('superseded');
  });

  it('checks four false values at most; a fifth turns the marker check off for the document', async () => {
    await armedAs(accountA);
    for (const value of ['false-value-0001', 'false-value-0002', 'false-value-0003', 'false-value-0004']) {
      setMarker(value);
      const reply = landing();
      await settle();
      guard.sessionChecked(guard.sessionReadStarted(), true);
      await reply.promise;
      expect(reply.outcome.state).toBe('delivered');
    }
    expect(requestSessionCheck).toHaveBeenCalledTimes(4);
    for (const value of ['false-value-0005', markerOf(accountB.authSessionId)]) {
      setMarker(value);
      const reply = landing();
      await reply.promise;
      expect(reply.outcome.state).toBe('delivered');
    }
    expect(requestSessionCheck).toHaveBeenCalledTimes(4);
    expect(reloadPage).not.toHaveBeenCalled();
  });

  it('does no marker check in an anonymous tab or before a login has its id', async () => {
    expect(guard.accept(null)).toBe('publish');
    await settle();
    setMarker(markerOf(accountB.authSessionId));
    await landing().promise;
    expect(guard.accept(signedInViewer('user-c', null))).toBe('publish');
    await settle();
    await landing().promise;
    expect(requestSessionCheck).not.toHaveBeenCalled();
  });

  it('never signs out or reloads on the marker alone', async () => {
    await armedAs(accountA);
    setMarker(markerOf(accountB.authSessionId));
    const reply = landing();
    await settle();
    guard.sessionChecked(guard.sessionReadStarted(), false);
    await reply.promise;
    expect(reloadPage).not.toHaveBeenCalled();
    expect(guard.viewerKey()).toBe('user-a:login-a');
  });
});

describe('viewer marker in runIfCurrent (toasts and navigation wait for a running check)', () => {
  it('runs a toast asked for during a check once the check confirms the same login, and tells subscribers', async () => {
    await armedAs(accountA);
    const generation = guard.capture();
    const subscriber = vi.fn<() => void>();
    guard.subscribe(subscriber);
    setMarker('tossed-value-005');
    const toast = vi.fn<() => void>();
    guard.runIfCurrent(generation, toast);
    expect(toast).not.toHaveBeenCalled();
    guard.sessionChecked(guard.sessionReadStarted(), true);
    await settle();
    expect(toast).toHaveBeenCalledTimes(1);
    expect(subscriber).toHaveBeenCalled();
    // Later ones under that value run at once.
    guard.runIfCurrent(generation, toast);
    expect(toast).toHaveBeenCalledTimes(2);
  });

  it('drops it when the check names another account or proves nothing', async () => {
    await armedAs(accountA);
    const generation = guard.capture();
    setMarker('outage-value-006');
    const unproven = vi.fn<() => void>();
    guard.runIfCurrent(generation, unproven);
    guard.sessionChecked(guard.sessionReadStarted(), false);
    await settle();
    expect(unproven).not.toHaveBeenCalled();

    setMarker(markerOf(accountB.authSessionId));
    const started = guard.sessionReadStarted();
    const switched = vi.fn<() => void>();
    guard.runIfCurrent(generation, switched);
    expect(guard.accept(accountB, started + 1)).toBe('retire');
    await settle();
    expect(switched).not.toHaveBeenCalled();
  });

  it('runs at once with the page’s own marker, and never for an earlier generation', async () => {
    await armedAs(accountA);
    const action = vi.fn<() => void>();
    guard.runIfCurrent(guard.capture() - 1, action);
    guard.runIfCurrent(guard.capture(), action);
    expect(action).toHaveBeenCalledTimes(1);
  });
});

describe('viewer marker in isCurrent (toasts and navigation)', () => {
  it('is false under a false marker until the check confirms the same login', async () => {
    await signedInAs(accountA);
    const generation = guard.capture();
    setMarker(markerOf(accountA.authSessionId));
    expect(guard.isCurrent(generation)).toBe(true);
    setMarker('tossed-value-004');
    expect(guard.isCurrent(generation)).toBe(false);
    expect(requestSessionCheck).toHaveBeenCalledTimes(1);
    expect(guard.isCurrent(generation)).toBe(false);
    expect(requestSessionCheck).toHaveBeenCalledTimes(1);
    guard.sessionChecked(guard.sessionReadStarted(), true);
    await settle();
    expect(guard.isCurrent(generation)).toBe(true);
  });
});
