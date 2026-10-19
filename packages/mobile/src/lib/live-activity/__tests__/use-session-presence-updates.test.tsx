// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { LiveActivityUpdateOptions } from '../../../../modules/live-activity/src/index';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('../../sentry', () => ({ captureToSentry: vi.fn() }));
vi.mock('../live-activity-plugin', () => ({
  updateLiveActivity: vi.fn(),
  updateLiveActivityClimb: vi.fn(),
}));

import { captureToSentry } from '../../sentry';
import { updateLiveActivity, updateLiveActivityClimb } from '../live-activity-plugin';
import { useSessionPresenceUpdates } from '../use-session-presence-updates';

const selectedItem = { uuid: 'private-queue-id' } as ClimbQueueItem;
const options: LiveActivityUpdateOptions = {
  sessionId: 'private-session-id',
  queueItemUuid: selectedItem.uuid,
  climbName: 'Private climb name',
  climbDifficulty: 'V4',
  angle: 40,
  currentIndex: 0,
  totalClimbs: 1,
  hasNext: false,
  hasPrevious: false,
  climbUuid: 'private-climb-id',
  queue: [],
  widgetNavigationAllowed: true,
  isPartySession: false,
  boardConnection: 'connectedByMe',
  holderDisplayName: null,
  androidThumbnailOverlayPath: 'file:///private/overlay.png',
  androidThumbnailBackgroundPaths: undefined,
};

function setup() {
  const refs = {
    isActiveRef: { current: true },
    generationRef: { current: 1 },
    sessionIdRef: { current: 'private-session-id' as string | null },
    currentClimbRef: { current: selectedItem as ClimbQueueItem | null },
    queueRef: { current: [selectedItem] },
  };
  const hook = renderHook(() => useSessionPresenceUpdates(refs));
  return { ...hook, refs };
}

async function flushUpdate(callback: () => void) {
  await act(async () => {
    callback();
    await Promise.resolve();
  });
}

describe('session-presence update recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(updateLiveActivity).mockReset().mockResolvedValue(undefined);
    vi.mocked(updateLiveActivityClimb).mockReset().mockResolvedValue(undefined);
    vi.mocked(captureToSentry).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['full', 'climb'] as const)(
    'contains %s rejection and retries once without ending the session',
    async (method) => {
      const nativeUpdate = method === 'full' ? updateLiveActivity : updateLiveActivityClimb;
      vi.mocked(nativeUpdate).mockRejectedValue(new Error('private-native-rejection'));
      const { result, refs } = setup();
      await flushUpdate(() => result.current.sendUpdate({ method, options }));
      expect(nativeUpdate).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(nativeUpdate).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(nativeUpdate).toHaveBeenCalledTimes(2);
      expect(refs.isActiveRef.current).toBe(true);
      expect(captureToSentry).toHaveBeenCalledTimes(2);
      // A later ordinary update can recover after the retry budget is exhausted.
      vi.mocked(nativeUpdate).mockResolvedValue(undefined);
      await flushUpdate(() => result.current.sendUpdate({ method, options }));
      expect(nativeUpdate).toHaveBeenCalledTimes(3);
    },
  );

  it.each(['full', 'climb'] as const)(
    'reports fixed %s field names and types without payload contents or raw rejection text',
    async (method) => {
      const nativeUpdate = method === 'full' ? updateLiveActivity : updateLiveActivityClimb;
      vi.mocked(nativeUpdate).mockRejectedValue('private-native-rejection');
      const { result } = setup();
      await flushUpdate(() => result.current.sendUpdate({ method, options }));
      const [error, context] = vi.mocked(captureToSentry).mock.calls[0];
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Session presence update rejected');
      expect(context?.extra?.optionShape).toEqual(
        expect.objectContaining({
          sessionId: 'string',
          supportsMirroring: 'missing',
          holderDisplayName: 'null',
          androidThumbnailOverlayPath: 'string',
          androidThumbnailBackgroundPaths: 'undefined',
        }),
      );
      expect(JSON.stringify(context)).not.toMatch(/private|Private|file:\/\//);
    },
  );

  it('cancels a scheduled retry when a newer update supersedes it', async () => {
    vi.mocked(updateLiveActivity).mockRejectedValueOnce(new Error('rejected'));
    const { result } = setup();
    await flushUpdate(() => result.current.sendUpdate({ method: 'full', options }));
    await flushUpdate(() => result.current.sendUpdate({ method: 'climb', options }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(updateLiveActivity).toHaveBeenCalledTimes(1);
    expect(updateLiveActivityClimb).toHaveBeenCalledTimes(1);
  });

  it.each(['generation', 'session', 'climb', 'inactive', 'queue'] as const)(
    'does not retry after the %s changes',
    async (change) => {
      vi.mocked(updateLiveActivity).mockRejectedValue(new Error('rejected'));
      const { result, refs } = setup();
      await flushUpdate(() => result.current.sendUpdate({ method: 'full', options }));
      if (change === 'generation') refs.generationRef.current += 1;
      if (change === 'session') refs.sessionIdRef.current = 'new-session';
      if (change === 'climb') refs.currentClimbRef.current = { uuid: 'new-item' } as ClimbQueueItem;
      if (change === 'inactive') refs.isActiveRef.current = false;
      if (change === 'queue') refs.queueRef.current = [];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(updateLiveActivity).toHaveBeenCalledTimes(1);
    },
  );

  it('ignores an old rejection that arrives after a newer update', async () => {
    let rejectOld!: (reason: Error) => void;
    vi.mocked(updateLiveActivity).mockReturnValueOnce(
      new Promise<void>((_, reject) => {
        rejectOld = reject;
      }),
    );
    const { result } = setup();
    await flushUpdate(() => result.current.sendUpdate({ method: 'full', options }));
    await flushUpdate(() => result.current.sendUpdate({ method: 'climb', options }));
    await flushUpdate(() => rejectOld(new Error('late rejection')));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(updateLiveActivity).toHaveBeenCalledTimes(1);
  });

  it('cancels scheduled and in-flight recovery on teardown', async () => {
    vi.mocked(updateLiveActivity).mockRejectedValue(new Error('rejected'));
    const { result } = setup();
    await flushUpdate(() => result.current.sendUpdate({ method: 'full', options }));
    expect(vi.getTimerCount()).toBe(1);
    act(() => result.current.cancelUpdateRetry());
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(updateLiveActivity).toHaveBeenCalledTimes(1);
  });
});
