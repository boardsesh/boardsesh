// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/queue';

// Force the session-presence branch (iOS) so the start effect actually runs.
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

vi.mock('../../auth-store', () => ({
  getAuthToken: vi.fn().mockResolvedValue('token-abc'),
}));

// Stub the bundled board-art resolver the start path lazily imports on iOS, so
// the dynamic import resolves deterministically (and never pulls expo-asset into
// the test env). Hoisted so individual tests can vary its resolved paths.
const backgroundCache = vi.hoisted(() => ({
  ensureBackgroundsCached: vi.fn(),
}));

vi.mock('../../background-image-cache', () => ({
  ensureBackgroundsCached: backgroundCache.ensureBackgroundsCached,
}));

const plugin = vi.hoisted(() => ({
  startLiveActivitySession: vi.fn(),
  endLiveActivitySession: vi.fn().mockResolvedValue(undefined),
  updateLiveActivity: vi.fn().mockResolvedValue(undefined),
  updateLiveActivityClimb: vi.fn().mockResolvedValue(undefined),
  isLiveActivityAvailable: vi.fn().mockResolvedValue(true),
}));

vi.mock('../live-activity-plugin', () => ({
  startLiveActivitySession: plugin.startLiveActivitySession,
  endLiveActivitySession: plugin.endLiveActivitySession,
  updateLiveActivity: plugin.updateLiveActivity,
  updateLiveActivityClimb: plugin.updateLiveActivityClimb,
  isLiveActivityAvailable: plugin.isLiveActivityAvailable,
}));

// Imported AFTER the mocks so the hook binds to the mocked plugin surface.
const { useLiveActivity } = await import('../use-live-activity');

function makeQueueItem(uuid: string): ClimbQueueItem {
  return {
    uuid,
    climb: {
      uuid: `climb-${uuid}`,
      name: `Climb ${uuid}`,
      difficulty: '7a',
      angle: 40,
      frames: 'p1r1',
    },
  } as unknown as ClimbQueueItem;
}

function Harness() {
  useLiveActivity({
    queue: [makeQueueItem('q1')],
    currentClimbQueueItem: makeQueueItem('q1'),
    board: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2' },
    sessionId: 'session-1',
    isSessionActive: true,
    widgetNavigationAllowed: true,
    isPartySession: false,
    boardConnection: 'connectedByMe',
  });
  return null;
}

// Flush the availability + auth-token promises, the lazily-imported board-art
// resolver, and the resulting effects. Macrotask turns drain the dynamic
// import()'s microtask chain reliably regardless of how many ticks it needs.
async function flushStart() {
  await act(async () => {
    for (let turn = 0; turn < 4; turn++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

describe('useLiveActivity start-failure cleanup', () => {
  beforeEach(() => {
    plugin.startLiveActivitySession.mockReset();
    plugin.endLiveActivitySession.mockClear();
    plugin.endLiveActivitySession.mockResolvedValue(undefined);
    backgroundCache.ensureBackgroundsCached.mockReset();
    backgroundCache.ensureBackgroundsCached.mockResolvedValue({ paths: [], missingCount: 0 });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('tears down the native session when the Live Activity start rejects', async () => {
    plugin.startLiveActivitySession.mockRejectedValue(new Error('LA_START_FAILED'));

    render(<Harness />);
    await flushStart();

    expect(plugin.startLiveActivitySession).toHaveBeenCalledTimes(1);
    // The native start populated the WS connection + keychain/App-Group state
    // before throwing, so the JS catch must call end to clean it up.
    expect(plugin.endLiveActivitySession).toHaveBeenCalledTimes(1);
  });

  it('does not call end when the start succeeds', async () => {
    plugin.startLiveActivitySession.mockResolvedValue(undefined);

    render(<Harness />);
    await flushStart();

    expect(plugin.startLiveActivitySession).toHaveBeenCalledTimes(1);
    expect(plugin.endLiveActivitySession).not.toHaveBeenCalled();
  });
});

describe('useLiveActivity board-background staging', () => {
  beforeEach(() => {
    plugin.startLiveActivitySession.mockReset();
    plugin.startLiveActivitySession.mockResolvedValue(undefined);
    backgroundCache.ensureBackgroundsCached.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves bundled backgrounds for the board and passes them to startLiveActivitySession', async () => {
    backgroundCache.ensureBackgroundsCached.mockResolvedValue({
      paths: ['/bg/kilter-1.webp', '/bg/kilter-2.webp'],
      missingCount: 0,
    });

    render(<Harness />);
    await flushStart();

    // Board string + comma setIds are validated/parsed (toBoardName + parseSetIds)
    // before the lookup, and the resolved paths flow through to the native start.
    expect(backgroundCache.ensureBackgroundsCached).toHaveBeenCalledWith(
      expect.objectContaining({ boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: [1, 2], variant: 'thumb' }),
    );
    expect(plugin.startLiveActivitySession).toHaveBeenCalledWith(
      expect.objectContaining({ boardBackgroundPaths: ['/bg/kilter-1.webp', '/bg/kilter-2.webp'] }),
    );
  });
});
