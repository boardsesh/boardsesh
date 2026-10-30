// @vitest-environment jsdom
// The wall button's one-time frost peek (#7113): once per app session, in at
// most three sessions, never after the swipe has been used, never in
// screenshot mode.
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ values: new Map<string, unknown>(), failReads: false }));
vi.mock('../preference-store', () => ({
  getPreference: vi.fn(async (key: string) => {
    if (store.failReads) throw new Error('store unavailable');
    return store.values.get(key) ?? null;
  }),
  setPreference: vi.fn(async (key: string, value: unknown) => {
    store.values.set(key, value);
  }),
  removePreference: vi.fn(async (key: string) => {
    store.values.delete(key);
  }),
}));

import {
  claimWallSwipePeek,
  markWallSwipeUsed,
  MAX_PEEK_SESSIONS,
  recordWallSwipePeekPlayed,
  resetWallSwipeHintSessionForTests,
  shouldPlayWallSwipePeek,
  useWallSwipePeek,
} from '../wall-swipe-hint';

/** Let the claim's background count land. */
const settle = () => act(async () => {});

beforeEach(() => {
  store.values.clear();
  store.failReads = false;
  resetWallSwipeHintSessionForTests();
  vi.unstubAllEnvs();
});

describe('wall swipe peek', () => {
  it('plays on a fresh device, once per session', async () => {
    expect(await shouldPlayWallSwipePeek()).toBe(true);
    expect(claimWallSwipePeek()).toBe(true);
    // A second button in the same session gets nothing.
    expect(claimWallSwipePeek()).toBe(false);
    expect(await shouldPlayWallSwipePeek()).toBe(false);
    // A claim alone counts nothing: only a peek that played does.
    await settle();
    expect(store.values.get('wallSwipePeekSessions')).toBeUndefined();
    recordWallSwipePeekPlayed();
    await settle();
    expect(store.values.get('wallSwipePeekSessions')).toBe(1);
  });

  it(`stops after ${MAX_PEEK_SESSIONS} sessions`, async () => {
    for (let session = 1; session <= MAX_PEEK_SESSIONS; session++) {
      resetWallSwipeHintSessionForTests();
      expect(await shouldPlayWallSwipePeek()).toBe(true);
      claimWallSwipePeek();
      recordWallSwipePeekPlayed();
      await settle();
    }
    resetWallSwipeHintSessionForTests();
    expect(await shouldPlayWallSwipePeek()).toBe(false);
  });

  it('stops for good once the swipe has been used', async () => {
    await markWallSwipeUsed();
    expect(await shouldPlayWallSwipePeek()).toBe(false);
    resetWallSwipeHintSessionForTests();
    expect(await shouldPlayWallSwipePeek()).toBe(false);
  });

  it('never plays in screenshot mode', async () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    expect(await shouldPlayWallSwipePeek()).toBe(false);
  });

  it('reads a store failure as no peek', async () => {
    store.failReads = true;
    expect(await shouldPlayWallSwipePeek()).toBe(false);
  });

  it('hands a button a token the first time the swipe is offered', async () => {
    const { result, rerender } = renderHook(({ offered }) => useWallSwipePeek(offered), {
      initialProps: { offered: false },
    });
    await settle();
    expect(result.current).toBe(0);
    rerender({ offered: true });
    await waitFor(() => expect(result.current).toBe(1));
    // Offered again later in the session: nothing more.
    rerender({ offered: false });
    rerender({ offered: true });
    await settle();
    expect(result.current).toBe(1);
  });
});
