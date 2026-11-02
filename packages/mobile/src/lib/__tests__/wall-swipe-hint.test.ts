// @vitest-environment jsdom
// The wall button's frost peek (#7113, spec B3 for 2.7): at the first
// keep-lighting window in an app session, plus one replay on the third Put on
// board within 5 minutes; in at most three sessions on a v2 count, or one
// last peek for a climber who saw 2.6's three; never after the swipe has been
// used, never in screenshot mode, never with a screen reader on.
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
  clearWallSwipeHint,
  markWallSwipeUsed,
  MAX_PEEK_SESSIONS,
  noteWallPutOnBoardPress,
  PUT_ON_BOARD_REPLAY_WINDOW_MS,
  recordWallSwipePeekPlayed,
  resetWallSwipeHintSessionForTests,
  shouldPlayWallSwipePeek,
  shouldPlayWallSwipeReplay,
  claimWallSwipeReplay,
  UPGRADE_PEEKS,
  useWallSwipePeek,
  wallSwipePeekOwed,
  type WallSwipePeekTriggers,
} from '../wall-swipe-hint';

/** Let the claim's background count land. */
const settle = () => act(async () => {});

const SESSIONS_V2 = 'wallSwipePeekSessionsV2';

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
    expect(store.values.get(SESSIONS_V2)).toBeUndefined();
    recordWallSwipePeekPlayed();
    await settle();
    expect(store.values.get(SESSIONS_V2)).toBe(1);
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

  // 2.7: the swipe means something new (keep the window going), so a climber
  // who saw 2.6's three peeks gets ONE more, not three. A swipe they already
  // drove with still stops it: they know the gesture.
  it(`gives a 2.6 climber who saw all ${MAX_PEEK_SESSIONS} peeks exactly ${UPGRADE_PEEKS} more`, async () => {
    store.values.set('wallSwipePeekSessions', MAX_PEEK_SESSIONS);
    expect(await shouldPlayWallSwipePeek()).toBe(true);
    expect(claimWallSwipePeek()).toBe(true);
    recordWallSwipePeekPlayed();
    await settle();
    expect(store.values.get(SESSIONS_V2)).toBe(1);
    // The next session: nothing.
    resetWallSwipeHintSessionForTests();
    expect(await shouldPlayWallSwipePeek()).toBe(false);
  });

  it('plays an upgrader no replay in the session that used their one peek', async () => {
    store.values.set('wallSwipePeekSessions', MAX_PEEK_SESSIONS);
    claimWallSwipePeek();
    recordWallSwipePeekPlayed();
    await settle();
    noteWallPutOnBoardPress(0);
    noteWallPutOnBoardPress(1);
    noteWallPutOnBoardPress(2);
    expect(await shouldPlayWallSwipeReplay()).toBe(false);
  });

  it('counts an upgrader whose one peek was the replay, so no window peek follows', async () => {
    store.values.set('wallSwipePeekSessions', MAX_PEEK_SESSIONS);
    noteWallPutOnBoardPress(0);
    noteWallPutOnBoardPress(1);
    noteWallPutOnBoardPress(2);
    expect(await shouldPlayWallSwipeReplay()).toBe(true);
    expect(claimWallSwipeReplay()).toBe(true);
    recordWallSwipePeekPlayed();
    await settle();
    expect(await shouldPlayWallSwipePeek()).toBe(false);
  });

  it('gives a climber 2.6 showed fewer than three the normal three sessions', async () => {
    store.values.set('wallSwipePeekSessions', MAX_PEEK_SESSIONS - 1);
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

  it('never plays for an upgrader who has swiped', async () => {
    store.values.set('wallSwipePeekSessions', MAX_PEEK_SESSIONS);
    store.values.set('wallSwipeUsed', true);
    expect(await shouldPlayWallSwipePeek()).toBe(false);
  });

  it('stops for good once the swipe has been used, on 2.6 too', async () => {
    store.values.set('wallSwipeUsed', true);
    expect(await shouldPlayWallSwipePeek()).toBe(false);
    store.values.clear();
    await markWallSwipeUsed();
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

  it('clears both counts and the used mark on the developer reset', async () => {
    store.values.set('wallSwipePeekSessions', 3);
    store.values.set(SESSIONS_V2, 3);
    store.values.set('wallSwipeUsed', true);
    await clearWallSwipeHint();
    expect([...store.values.keys()]).toEqual([]);
  });
});

describe('the replay on the third Put on board within 5 minutes', () => {
  it('is owed after three presses inside the window', async () => {
    noteWallPutOnBoardPress(0);
    noteWallPutOnBoardPress(60_000);
    expect(await shouldPlayWallSwipeReplay()).toBe(false);
    noteWallPutOnBoardPress(PUT_ON_BOARD_REPLAY_WINDOW_MS - 1);
    expect(await shouldPlayWallSwipeReplay()).toBe(true);
  });

  it('is not owed for presses spread past 5 minutes', async () => {
    noteWallPutOnBoardPress(0);
    noteWallPutOnBoardPress(PUT_ON_BOARD_REPLAY_WINDOW_MS);
    noteWallPutOnBoardPress(2 * PUT_ON_BOARD_REPLAY_WINDOW_MS);
    expect(await shouldPlayWallSwipeReplay()).toBe(false);
  });

  it('counts a session once, whether one peek played or two', async () => {
    claimWallSwipePeek();
    recordWallSwipePeekPlayed();
    await settle();
    // The replay plays later in the same session.
    recordWallSwipePeekPlayed();
    await settle();
    expect(store.values.get(SESSIONS_V2)).toBe(1);
  });

  it('still replays in the session whose window peek used up the third count', async () => {
    store.values.set(SESSIONS_V2, MAX_PEEK_SESSIONS - 1);
    claimWallSwipePeek();
    recordWallSwipePeekPlayed();
    await settle();
    noteWallPutOnBoardPress(0);
    noteWallPutOnBoardPress(1);
    noteWallPutOnBoardPress(2);
    expect(await shouldPlayWallSwipeReplay()).toBe(true);
    // The next session has none left.
    resetWallSwipeHintSessionForTests();
    expect(await shouldPlayWallSwipePeek()).toBe(false);
  });
});

describe('useWallSwipePeek', () => {
  const triggers = (over: Partial<WallSwipePeekTriggers> = {}): WallSwipePeekTriggers => ({
    offered: true,
    windowLive: false,
    screenReaderOn: false,
    ...over,
  });

  it('plays at the first keep-lighting window in a session, not before, and not again', async () => {
    const { result, rerender } = renderHook((props: WallSwipePeekTriggers) => useWallSwipePeek(props), {
      initialProps: triggers(),
    });
    // The swipe on offer alone is no longer the moment (2.6 was).
    await settle();
    expect(result.current).toBe(0);
    rerender(triggers({ windowLive: true }));
    await waitFor(() => expect(result.current).toBe(1));
    // The window ends and another opens later in the session: nothing more.
    rerender(triggers({ windowLive: false }));
    rerender(triggers({ windowLive: true }));
    await settle();
    expect(result.current).toBe(1);
  });

  it('replays once on the third Put on board within 5 minutes', async () => {
    const { result } = renderHook((props: WallSwipePeekTriggers) => useWallSwipePeek(props), {
      initialProps: triggers(),
    });
    act(() => {
      noteWallPutOnBoardPress(0);
      noteWallPutOnBoardPress(1_000);
      noteWallPutOnBoardPress(2_000);
    });
    await waitFor(() => expect(result.current).toBe(1));
    act(() => {
      noteWallPutOnBoardPress(3_000);
      noteWallPutOnBoardPress(4_000);
      noteWallPutOnBoardPress(5_000);
    });
    await settle();
    expect(result.current).toBe(1);
  });

  it('plays the replay on one button only when two are mounted', async () => {
    const first = renderHook((props: WallSwipePeekTriggers) => useWallSwipePeek(props), { initialProps: triggers() });
    const second = renderHook((props: WallSwipePeekTriggers) => useWallSwipePeek(props), { initialProps: triggers() });
    act(() => {
      noteWallPutOnBoardPress(0);
      noteWallPutOnBoardPress(1);
      noteWallPutOnBoardPress(2);
    });
    await waitFor(() => expect(first.result.current + second.result.current).toBe(1));
    await settle();
    expect(first.result.current + second.result.current).toBe(1);
  });

  it('never plays with a screen reader on, or where the swipe is not offered', async () => {
    const reader = renderHook((props: WallSwipePeekTriggers) => useWallSwipePeek(props), {
      initialProps: triggers({ windowLive: true, screenReaderOn: true }),
    });
    const noSwipe = renderHook((props: WallSwipePeekTriggers) => useWallSwipePeek(props), {
      initialProps: triggers({ offered: false, windowLive: true }),
    });
    act(() => {
      noteWallPutOnBoardPress(0);
      noteWallPutOnBoardPress(1);
      noteWallPutOnBoardPress(2);
    });
    await settle();
    expect(reader.result.current).toBe(0);
    expect(noSwipe.result.current).toBe(0);
  });
});

// The allowance, as one rule: upgraders (2.6's count at three) one peek,
// newcomers and partial 2.6 climbers three sessions, swiped climbers none.
describe('wallSwipePeekOwed', () => {
  const owed = (over: Partial<Parameters<typeof wallSwipePeekOwed>[0]> = {}) =>
    wallSwipePeekOwed({ used: false, legacySessions: null, sessions: null, countedThisSession: false, ...over });

  it.each([
    ['a newcomer', {}, true],
    ['a newcomer after two sessions', { sessions: 2 }, true],
    ['a newcomer after three sessions', { sessions: 3 }, false],
    ['a newcomer mid-session after the third', { sessions: 3, countedThisSession: true }, true],
    ['an upgrader', { legacySessions: 3 }, true],
    ['an upgrader past 2.6’s count', { legacySessions: 5 }, true],
    ['an upgrader after their peek', { legacySessions: 3, sessions: 1 }, false],
    ['an upgrader mid-session after their peek', { legacySessions: 3, countedThisSession: true }, false],
    ['a partial 2.6 climber', { legacySessions: 2, sessions: 2 }, true],
    ['a newcomer who swiped', { used: true }, false],
    ['an upgrader who swiped', { used: true, legacySessions: 3 }, false],
  ] as const)('%s', (_label, over, expected) => {
    expect(owed(over)).toBe(expected);
  });
});
