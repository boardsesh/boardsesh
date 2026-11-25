import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test';
import { createSessionGuard, type SessionGuard } from '../auth/session-guard';

const capture = { track: vi.fn(), trackBeforeNavigation: vi.fn() };
let guard: SessionGuard;
let grant: object | null;
vi.mock('../auth/session-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth/session-guard')>()),
  browserSessionGuard: () => guard,
}));
vi.mock('../consent', () => ({
  hasAnalyticsConsent: () => grant !== null,
  getWebConsentRecord: () => grant,
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { resolve, promise };
}

async function coldCapture() {
  const started = deferred();
  const release = deferred();
  const load = vi.fn(async () => {
    started.resolve();
    await release.promise;
    return capture;
  });
  vi.doMock('../analytics', load);
  return { ...(await import('../analytics-capture')), started, release, load };
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  guard = createSessionGuard({ reloadPage: vi.fn(), requestSessionCheck: vi.fn() });
  grant = {};
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  vi.doUnmock('../analytics');
  vi.useRealTimers();
});

it('drops clicks before the accepted session and before consent, even if both resolve later', async () => {
  const facade = await coldCapture();
  facade.track('unresolved session');
  guard.accept(null);
  grant = null;
  await facade.trackBeforeNavigation('denied click');
  grant = {};
  expect(facade.load).not.toHaveBeenCalled();
  facade.track('authorized click', { placement: 'header' });
  await facade.started.promise;
  facade.release.resolve();
  await vi.dynamicImportSettled();
  expect(capture.track).toHaveBeenCalledExactlyOnceWith('authorized click', { placement: 'header' });
  expect(capture.trackBeforeNavigation).not.toHaveBeenCalled();
});

it.each(['withdrawal', 'new grant', 'account switch', 'new login', 'return to prior login'] as const)(
  'drops a cold event after %s',
  async (change) => {
    guard.accept({ userId: 'climber', authSessionId: 'login-a' });
    const facade = await coldCapture();
    facade.track('original event');
    await facade.started.promise;
    if (change === 'withdrawal' || change === 'new grant') {
      grant = null;
      if (change === 'new grant') grant = {};
    } else if (change === 'account switch') {
      guard.expectLocalChange();
      guard.accept({ userId: 'other-climber', authSessionId: 'login-b' });
    } else {
      guard.accept({ userId: 'climber', authSessionId: 'login-b' });
      if (change === 'return to prior login') guard.accept({ userId: 'climber', authSessionId: 'login-a' });
    }
    facade.release.resolve();
    await vi.dynamicImportSettled();
    expect(capture.track).not.toHaveBeenCalled();
  },
);

it('bounds retained events while the chunk is unavailable', async () => {
  guard.accept(null);
  const facade = await coldCapture();
  for (let index = 0; index < 40; index++) facade.track('cold event');
  await facade.started.promise;
  facade.release.resolve();
  await vi.dynamicImportSettled();
  expect(capture.track).toHaveBeenCalledTimes(16);
  facade.track('warm event');
  expect(capture.track).toHaveBeenLastCalledWith('warm event', undefined);
});

it('drops a cold event when the document URL changes', async () => {
  guard.accept(null);
  window.history.replaceState(null, '', '/boards');
  const facade = await coldCapture();
  facade.track('original location');
  await facade.started.promise;
  window.history.replaceState(null, '', '/gyms');
  facade.release.resolve();
  await vi.dynamicImportSettled();
  expect(capture.track).not.toHaveBeenCalled();
});

it.each(['/admin', '/oauth/authorize', '/?invite=private-board'])(
  'rejects an excluded event from %s before loading capture',
  async (pathname) => {
    guard.accept(null);
    window.history.replaceState(null, '', pathname);
    const facade = await coldCapture();
    facade.track('excluded location');
    window.history.replaceState(null, '', '/gyms');
    expect(facade.load).not.toHaveBeenCalled();
    expect(capture.track).not.toHaveBeenCalled();
  },
);

it('keeps a QR event when the landing tracker removes its own attribution pair', async () => {
  guard.accept(null);
  window.history.replaceState(null, '', '/?src=qr&medium=desktop&utm_source=poster');
  const facade = await coldCapture();
  facade.track('QR scan');
  await facade.started.promise;
  window.history.replaceState(null, '', '/?utm_source=poster');
  facade.release.resolve();
  await vi.dynamicImportSettled();
  expect(capture.track).toHaveBeenCalledExactlyOnceWith('QR scan', undefined);
});

it.each(['import', 'flush'] as const)('releases navigation once at 250 ms when the %s stalls', async (stall) => {
  guard.accept(null);
  const facade = await coldCapture();
  const flush = deferred();
  capture.trackBeforeNavigation.mockReturnValue(flush.promise);
  vi.useFakeTimers();
  const navigate = vi.fn();
  const navigation = facade.trackBeforeNavigation('departing click').then(navigate);
  await facade.started.promise;
  if (stall === 'flush') {
    await vi.advanceTimersByTimeAsync(150);
    facade.release.resolve();
    await vi.advanceTimersByTimeAsync(0);
  }
  await vi.advanceTimersByTimeAsync(stall === 'flush' ? 99 : 249);
  expect(navigate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await navigation;
  expect(navigate).toHaveBeenCalledOnce();
  facade.release.resolve();
  flush.resolve();
  await vi.dynamicImportSettled();
  expect(navigate).toHaveBeenCalledOnce();
  expect(capture.trackBeforeNavigation).toHaveBeenCalledTimes(stall === 'flush' ? 1 : 0);
});

it('releases the destination when the chunk fails', async () => {
  guard.accept(null);
  vi.doMock('../analytics', () => {
    throw new Error('chunk unavailable');
  });
  const facade = await import('../analytics-capture');
  await expect(facade.trackBeforeNavigation('departing click')).resolves.toBeUndefined();
});
