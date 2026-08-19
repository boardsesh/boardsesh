// @vitest-environment jsdom
import { render, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/queue';

// The hook only touches Platform from react-native; the real entry throws under
// vitest's node/jsdom env (untransformed RN-native source), so stub it.
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));

vi.mock('../../auth-store', () => ({
  getAuthToken: vi.fn().mockResolvedValue('token-123'),
}));

vi.mock('../../env', () => ({
  BACKEND_URL: 'https://backend.test',
  WEB_BASE_URL: 'https://web.test',
}));

const plugin = vi.hoisted(() => ({
  isLiveActivityAvailable: vi.fn(),
  startLiveActivitySession: vi.fn(),
  endLiveActivitySession: vi.fn(),
  updateLiveActivity: vi.fn(),
  updateLiveActivityClimb: vi.fn(),
}));

vi.mock('../live-activity-plugin', () => plugin);

import { useLiveActivity } from '../use-live-activity';
import { getAuthToken } from '../../auth-store';

const queueItem = {
  uuid: 'queue-item-1',
  climb: {
    uuid: 'climb-1',
    name: 'Test Climb',
    difficulty: 'V4',
    angle: 40,
    frames: 'p1r1',
    setter_username: 'setter',
    mirrored: false,
  },
} as unknown as ClimbQueueItem;

const nextQueueItem = {
  uuid: 'queue-item-2',
  climb: {
    uuid: 'climb-2',
    name: 'Next Climb',
    difficulty: 'V5',
    angle: 45,
    frames: 'p2r2',
    setter_username: 'setter',
    mirrored: false,
  },
} as unknown as ClimbQueueItem;

type HookProps = Parameters<typeof useLiveActivity>[0];

type DeferredStartPromise = {
  promise: Promise<void>;
  reject: (reason?: unknown) => void;
  resolve: () => void;
};

function createDeferredStartPromise(): DeferredStartPromise {
  let resolvePromise!: () => void;
  let rejectPromise!: (reason?: unknown) => void;

  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return { promise, reject: rejectPromise, resolve: resolvePromise };
}

function activeProps(overrides: Partial<HookProps> = {}): HookProps {
  return {
    queue: [queueItem],
    currentClimbQueueItem: queueItem,
    board: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2' },
    sessionId: 'session-1',
    isSessionActive: true,
    widgetNavigationAllowed: true,
    isPartySession: false,
    boardConnection: 'connectedByMe',
    ...overrides,
  };
}

function Harness(props: HookProps) {
  useLiveActivity(props);
  return null;
}

describe('useLiveActivity start-failure contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    plugin.isLiveActivityAvailable.mockResolvedValue(true);
    plugin.updateLiveActivity.mockResolvedValue(undefined);
    plugin.updateLiveActivityClimb.mockResolvedValue(undefined);
    plugin.endLiveActivitySession.mockResolvedValue(undefined);
    // Quiet the expected "[LiveActivity] startSession failed" warning.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the initial update once the session starts', async () => {
    plugin.startLiveActivitySession.mockResolvedValue(undefined);

    render(<Harness {...activeProps()} />);

    await waitFor(() => expect(plugin.startLiveActivitySession).toHaveBeenCalledTimes(1));
    expect(plugin.startLiveActivitySession).toHaveBeenCalledWith(
      expect.objectContaining({ serverUrl: 'https://backend.test' }),
    );
    await waitFor(() => expect(plugin.updateLiveActivity).toHaveBeenCalledTimes(1));
    expect(plugin.updateLiveActivity).toHaveBeenCalledWith(
      expect.objectContaining({ climbName: 'Test Climb', currentIndex: 0, totalClimbs: 1 }),
    );
  });

  it('refreshes an Android thumbnail when its generation changes at the same path', async () => {
    plugin.startLiveActivitySession.mockResolvedValue(undefined);
    const props = activeProps({
      androidThumbnailOverlayPath: 'file:///cache/overlay.png',
      androidThumbnailOverlayLoadKey: '1:0',
    });
    const { rerender } = render(<Harness {...props} />);
    await waitFor(() => expect(plugin.updateLiveActivity).toHaveBeenCalled());
    plugin.updateLiveActivity.mockClear();
    plugin.updateLiveActivityClimb.mockClear();

    rerender(<Harness {...props} androidThumbnailOverlayLoadKey="2:1" />);

    await waitFor(() => expect(plugin.updateLiveActivity).toHaveBeenCalledTimes(1));
    expect(plugin.updateLiveActivity).toHaveBeenCalledWith(
      expect.objectContaining({ androidThumbnailOverlayPath: 'file:///cache/overlay.png' }),
    );
    expect(plugin.updateLiveActivityClimb).not.toHaveBeenCalled();
  });

  it('revalidates the Android overlay immediately before a later notification push', async () => {
    plugin.startLiveActivitySession.mockResolvedValue(undefined);
    const validateAndroidThumbnailOverlay = vi
      .fn<(path: string | null, loadKey: string | null) => string | null>()
      .mockImplementation((path) => path);
    const props = activeProps({
      androidThumbnailOverlayPath: 'file:///cache/overlay.png',
      androidThumbnailOverlayLoadKey: '1:0',
      validateAndroidThumbnailOverlay,
    });
    const { rerender } = render(<Harness {...props} />);
    await waitFor(() => expect(plugin.updateLiveActivity).toHaveBeenCalled());
    expect(validateAndroidThumbnailOverlay).toHaveBeenCalledWith('file:///cache/overlay.png', '1:0');
    plugin.updateLiveActivity.mockClear();
    plugin.updateLiveActivityClimb.mockClear();
    validateAndroidThumbnailOverlay.mockReturnValue(null);

    rerender(<Harness {...props} boardConnection="heldByPeer" />);

    await waitFor(() => expect(plugin.updateLiveActivity).toHaveBeenCalledTimes(1));
    expect(plugin.updateLiveActivity).toHaveBeenCalledWith(
      expect.objectContaining({ androidThumbnailOverlayPath: null }),
    );
    expect(validateAndroidThumbnailOverlay).toHaveBeenLastCalledWith('file:///cache/overlay.png', '1:0');
  });

  it('does not leak updates when the session fails to start', async () => {
    // e.g. Android threw MissingBluetoothPermissionException — the native session
    // never activated, so the hook must not behave as if it did.
    plugin.startLiveActivitySession.mockRejectedValue(new Error('permission denied'));

    render(<Harness {...activeProps()} />);

    await waitFor(() => expect(plugin.startLiveActivitySession).toHaveBeenCalledTimes(1));
    // Let the rejection + any follow-on effects settle.
    await act(async () => {
      await Promise.resolve();
    });

    expect(plugin.updateLiveActivity).not.toHaveBeenCalled();
    expect(plugin.updateLiveActivityClimb).not.toHaveBeenCalled();
  });

  it('retries the start on a later activation after a failure', async () => {
    plugin.startLiveActivitySession.mockRejectedValueOnce(new Error('permission denied')).mockResolvedValue(undefined);

    // Reuse one props object (stable queue array) so toggling isSessionActive is
    // the only change — otherwise a fresh queue array would refire the queue-sync
    // effect and muddy the update assertion below.
    const props = activeProps();
    const { rerender } = render(<Harness {...props} />);
    await waitFor(() => expect(plugin.startLiveActivitySession).toHaveBeenCalledTimes(1));
    expect(plugin.updateLiveActivity).not.toHaveBeenCalled();

    // Session deactivates, then activates again — the hook should attempt a fresh
    // start rather than stay stuck after the earlier failure.
    rerender(<Harness {...props} isSessionActive={false} />);
    await act(async () => {
      await Promise.resolve();
    });
    rerender(<Harness {...props} />);

    await waitFor(() => expect(plugin.startLiveActivitySession).toHaveBeenCalledTimes(2));
    // The successful retry must push the initial state, just like a clean start.
    await waitFor(() =>
      expect(plugin.updateLiveActivity).toHaveBeenCalledWith(
        expect.objectContaining({ climbName: 'Test Climb', currentIndex: 0, totalClimbs: 1 }),
      ),
    );
  });

  it('retries the start automatically after a transient failure, within budget', async () => {
    vi.useFakeTimers();
    try {
      // Two transient rejections (e.g. a stale activity still counting against
      // the ActivityKit limit), then success — all within one activation.
      plugin.startLiveActivitySession
        .mockRejectedValueOnce(new Error('transient'))
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValue(undefined);

      render(<Harness {...activeProps()} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(plugin.startLiveActivitySession).toHaveBeenCalledTimes(1);

      // Attempt 2 fires after one backoff step…
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000);
      });
      expect(plugin.startLiveActivitySession).toHaveBeenCalledTimes(2);

      // …attempt 3 after two steps, and it succeeds: initial state pushed.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8000);
      });
      expect(plugin.startLiveActivitySession).toHaveBeenCalledTimes(3);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(plugin.updateLiveActivity).toHaveBeenCalledWith(
        expect.objectContaining({ climbName: 'Test Climb', currentIndex: 0, totalClimbs: 1 }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops retrying once the budget is exhausted', async () => {
    vi.useFakeTimers();
    try {
      plugin.startLiveActivitySession.mockRejectedValue(new Error('persistent'));

      render(<Harness {...activeProps()} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(plugin.startLiveActivitySession).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000);
      });
      expect(plugin.startLiveActivitySession).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8000);
      });
      expect(plugin.startLiveActivitySession).toHaveBeenCalledTimes(3);
      // Budget exhausted (initial attempt + 2 retries) — silence from here.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(plugin.startLiveActivitySession).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a newer session active when an older start rejects late', async () => {
    const firstStart = createDeferredStartPromise();
    plugin.startLiveActivitySession.mockReturnValueOnce(firstStart.promise).mockResolvedValueOnce(undefined);

    const props = activeProps({
      queue: [queueItem, nextQueueItem],
      currentClimbQueueItem: queueItem,
    });
    const { rerender } = render(<Harness {...props} />);
    await waitFor(() => expect(plugin.startLiveActivitySession).toHaveBeenCalledTimes(1));

    rerender(<Harness {...props} isSessionActive={false} />);
    await act(async () => {
      await Promise.resolve();
    });
    rerender(<Harness {...props} />);
    await waitFor(() => expect(plugin.startLiveActivitySession).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(plugin.updateLiveActivity).toHaveBeenCalled());

    plugin.updateLiveActivity.mockClear();
    plugin.updateLiveActivityClimb.mockClear();

    await act(async () => {
      firstStart.reject(new Error('stale permission denied'));
      await Promise.resolve();
    });
    rerender(<Harness {...props} currentClimbQueueItem={nextQueueItem} />);

    await waitFor(() =>
      expect(plugin.updateLiveActivityClimb).toHaveBeenCalledWith(
        expect.objectContaining({ climbName: 'Next Climb', currentIndex: 1, totalClimbs: 2 }),
      ),
    );
  });
});

describe('useLiveActivity auth-token gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    plugin.isLiveActivityAvailable.mockResolvedValue(true);
    plugin.updateLiveActivity.mockResolvedValue(undefined);
    plugin.updateLiveActivityClimb.mockResolvedValue(undefined);
    plugin.endLiveActivitySession.mockResolvedValue(undefined);
    plugin.startLiveActivitySession.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("waits for the new session's token load instead of starting with the previous one", async () => {
    // Guest phase: SecureStore answers null while no session is active.
    vi.mocked(getAuthToken).mockResolvedValueOnce(null);

    const { rerender } = render(<Harness {...activeProps({ sessionId: null, isSessionActive: false })} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(plugin.startLiveActivitySession).not.toHaveBeenCalled();

    // The user signed in; the next SecureStore read returns the fresh token,
    // but slowly — the start must wait for it rather than racing ahead with
    // the guest-phase null (which silently killed push registration for the
    // whole session).
    let resolveToken!: (token: string | null) => void;
    vi.mocked(getAuthToken).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveToken = resolve;
        }),
    );

    rerender(<Harness {...activeProps({ sessionId: 'session-2' })} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(plugin.startLiveActivitySession).not.toHaveBeenCalled();

    await act(async () => {
      resolveToken('fresh-token');
      await Promise.resolve();
    });
    await waitFor(() => expect(plugin.startLiveActivitySession).toHaveBeenCalledTimes(1));
    expect(plugin.startLiveActivitySession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-2', authToken: 'fresh-token' }),
    );
  });
});

// This file stubs Platform.OS as 'android'. The iOS shared-queue mirror (#4413)
// deliberately does NOT extend here: every Android board write goes through JS,
// so there is no native relight to feed, and pushing state without a session
// would put a foreground-service notification in front of a solo queue.
describe('useLiveActivity Android session gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    plugin.isLiveActivityAvailable.mockResolvedValue(true);
    plugin.updateLiveActivity.mockResolvedValue(undefined);
    plugin.updateLiveActivityClimb.mockResolvedValue(undefined);
    plugin.endLiveActivitySession.mockResolvedValue(undefined);
    plugin.startLiveActivitySession.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pushes nothing to the session-presence surface without an active session', async () => {
    render(<Harness {...activeProps({ sessionId: null, isSessionActive: false })} />);

    await waitFor(() => expect(plugin.isLiveActivityAvailable).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });

    expect(plugin.startLiveActivitySession).not.toHaveBeenCalled();
    expect(plugin.updateLiveActivity).not.toHaveBeenCalled();
    expect(plugin.updateLiveActivityClimb).not.toHaveBeenCalled();
  });
});
