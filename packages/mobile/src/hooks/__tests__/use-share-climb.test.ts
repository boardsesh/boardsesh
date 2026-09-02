// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const ctrl = vi.hoisted(() => ({ os: 'ios' as string }));

type IOSPayload = { message: string; url: string };
type AndroidPayload = { message: string };
type SharePayload = IOSPayload | AndroidPayload;

const shareMock = vi.fn<(payload: SharePayload) => Promise<{ action: string }>>(async () => ({
  action: 'sharedAction',
}));

// Fire-and-forget prewarm fetches hit this mock; never a real network.
const fetchMock = vi.fn<(input: string) => Promise<{ ok: boolean }>>(async () => ({ ok: true }));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return ctrl.os;
    },
  },
  Share: {
    share: (payload: SharePayload) => shareMock(payload),
  },
}));

vi.mock('../../lib/env', () => ({
  CLIMB_SHARE_BASE_URL: 'https://www.boardsesh.com',
  BACKEND_URL: 'https://ws.boardsesh.com',
}));

import { useShareClimb } from '../use-share-climb';

const climb = {
  uuid: 'climb-uuid-123',
  name: 'Test Climb',
} as unknown as Parameters<typeof useShareClimb>[0]['climb'];

const baseArgs = {
  boardName: 'kilter',
  layoutId: 1,
  sizeId: 7,
  setIds: '1,20',
  angle: 40,
};

const expectedReadableShareUrl =
  'https://www.boardsesh.com/kilter/original/12x14-commercial/screw_bolt/40/view/test-climb-climb-uuid-123';

const climbWithFrames = {
  uuid: 'climb-uuid-123',
  name: 'Test Climb',
  frames: 'p1145r15p1146r12',
} as unknown as Parameters<typeof useShareClimb>[0]['climb'];

// The backend canonicalises set_ids server-side; the client sorts them too so
// the raw URL is stable regardless of input order.
//
// The render params have to match web's `buildOgBoardRenderUrl` exactly. This
// URL only warms a cache — the card a crawler fetches is the one in www's
// og:image — so a disagreement about the drawing warms an entry nobody asks for
// and leaves the reader on a cold render.
const expectedOgImageUrl =
  'https://ws.boardsesh.com/og/climb?board_name=kilter&layout_id=1&size_id=7&set_ids=1%2C20&frames=p1145r15p1146r12&format=jpeg&render_mode=aura&field_color=%23181225';

describe('useShareClimb', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ctrl.os = 'ios';
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a no-op when climb is null and does not call Share', async () => {
    const { result } = renderHook(() => useShareClimb({ climb: null, ...baseArgs }));
    await act(async () => {
      await result.current();
    });
    expect(shareMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('share-time cache prewarm', () => {
    it('warms the share page url before opening the share sheet', async () => {
      const { result } = renderHook(() => useShareClimb({ climb, ...baseArgs }));
      await act(async () => {
        await result.current();
      });
      expect(fetchMock).toHaveBeenCalledWith(expectedReadableShareUrl);
      // Exactly one warm: the no-frames climb must not fire an og request.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(shareMock).toHaveBeenCalledTimes(1);
    });

    it('warms the backend og image url too when the climb has frames', async () => {
      const { result } = renderHook(() => useShareClimb({ climb: climbWithFrames, ...baseArgs }));
      await act(async () => {
        await result.current();
      });
      expect(fetchMock).toHaveBeenNthCalledWith(1, expectedReadableShareUrl);
      expect(fetchMock).toHaveBeenNthCalledWith(2, expectedOgImageUrl);
    });

    it('sorts unsorted set_ids in the warmed og url', async () => {
      const { result } = renderHook(() => useShareClimb({ climb: climbWithFrames, ...baseArgs, setIds: '20,1' }));
      await act(async () => {
        await result.current();
      });
      expect(fetchMock).toHaveBeenNthCalledWith(2, expectedOgImageUrl);
    });

    it('still opens the share sheet when a prewarm fetch rejects', async () => {
      fetchMock.mockRejectedValue(new Error('network down'));
      const { result } = renderHook(() => useShareClimb({ climb: climbWithFrames, ...baseArgs }));
      await act(async () => {
        await result.current();
      });
      expect(shareMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('iOS', () => {
    it('passes { message: climbName, url } — message has name only so URL appears exactly once', async () => {
      const { result } = renderHook(() => useShareClimb({ climb, ...baseArgs }));
      await act(async () => {
        await result.current();
      });
      expect(shareMock).toHaveBeenCalledTimes(1);
      const firstCall = shareMock.mock.calls[0];
      if (!firstCall) throw new Error('Share.share was not called');
      const payload = firstCall[0];
      if (!('url' in payload)) throw new Error('Expected iOS payload shape { message, url }');
      expect(payload.url).toBe(expectedReadableShareUrl);
      expect(payload.url).not.toContain('/1/7/1,20/');
      expect(payload.message).toBe('Test Climb');
      expect(payload.message).not.toMatch(/https?:\/\//);
      expect(payload).not.toHaveProperty('title');
    });
  });

  describe('Android', () => {
    beforeEach(() => {
      ctrl.os = 'android';
    });

    it('embeds climb name and URL in message — url field is ignored by the Android Share API', async () => {
      const { result } = renderHook(() => useShareClimb({ climb, ...baseArgs }));
      await act(async () => {
        await result.current();
      });
      expect(shareMock).toHaveBeenCalledTimes(1);
      const firstCall = shareMock.mock.calls[0];
      if (!firstCall) throw new Error('Share.share was not called');
      const payload = firstCall[0];
      if (!('message' in payload)) throw new Error('Expected Android payload shape { message }');
      expect(payload.message).toContain('Test Climb');
      expect(payload.message).toContain(expectedReadableShareUrl);
      expect(payload.message).not.toContain('/1/7/1,20/');
      expect(payload).not.toHaveProperty('url');
    });
  });

  it('propagates rejections from Share.share so callers can surface failures', async () => {
    shareMock.mockRejectedValueOnce(new Error('user cancelled'));
    const { result } = renderHook(() => useShareClimb({ climb, ...baseArgs }));
    await act(async () => {
      await expect(result.current()).rejects.toThrow('user cancelled');
    });
  });

  it('returns a new callback when the climb identity changes', () => {
    const { result, rerender } = renderHook(({ c }) => useShareClimb({ climb: c, ...baseArgs }), {
      initialProps: { c: climb },
    });
    const firstShare = result.current;

    rerender({ c: { ...climb, uuid: 'different-uuid' } as typeof climb });
    expect(result.current).not.toBe(firstShare);
  });

  it('reuses the same callback when nothing relevant changes', () => {
    const { result, rerender } = renderHook(({ c }) => useShareClimb({ climb: c, ...baseArgs }), {
      initialProps: { c: climb },
    });
    const firstShare = result.current;

    rerender({ c: climb });
    expect(result.current).toBe(firstShare);
  });
});
