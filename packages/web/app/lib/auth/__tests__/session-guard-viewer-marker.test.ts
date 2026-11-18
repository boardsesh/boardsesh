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
    await signedInAs(accountA);
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
    await signedInAs(accountA);
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
    await signedInAs(accountA);
    setMarker('tossed-value-002');
    const started = guard.sessionReadStarted();
    const reply = landing();
    await settle();
    expect(guard.accept(accountA, started + 1)).toBe('publish');
    await reply.promise;
    expect(reply.outcome.state).toBe('delivered');
  });

  it('supersedes the held reply when the check proves nothing, and delivers later ones under that value', async () => {
    await signedInAs(accountA);
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

  it('treats two differing copies as unknown', async () => {
    await signedInAs(accountA);
    documentCookie = `${MARKER_NAME}=${markerOf(accountA.authSessionId)}; ${MARKER_NAME}=${markerOf(accountB.authSessionId)}`;
    await landing().promise;
    expect(requestSessionCheck).not.toHaveBeenCalled();
  });

  it('checks four false values at most; a fifth turns the marker check off for the document', async () => {
    await signedInAs(accountA);
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
    await signedInAs(accountA);
    setMarker(markerOf(accountB.authSessionId));
    const reply = landing();
    await settle();
    guard.sessionChecked(guard.sessionReadStarted(), false);
    await reply.promise;
    expect(reloadPage).not.toHaveBeenCalled();
    expect(guard.viewerKey()).toBe('user-a:login-a');
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
