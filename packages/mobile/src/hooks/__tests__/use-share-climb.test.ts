// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const ctrl = vi.hoisted(() => ({ os: 'ios' as string }));

type IOSPayload = { message: string; url: string };
type AndroidPayload = { message: string };
type SharePayload = IOSPayload | AndroidPayload;

const shareMock = vi.fn<(payload: SharePayload) => Promise<{ action: string }>>(async () => ({
  action: 'sharedAction',
}));

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
  WEB_BASE_URL: 'https://www.boardsesh.com',
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
  'https://www.boardsesh.com/kilter/original/12x14-commerical/screw_bolt/40/view/test-climb-climb-uuid-123';

describe('useShareClimb', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ctrl.os = 'ios';
  });

  it('returns a no-op when climb is null and does not call Share', async () => {
    const { result } = renderHook(() => useShareClimb({ climb: null, ...baseArgs }));
    await act(async () => {
      await result.current();
    });
    expect(shareMock).not.toHaveBeenCalled();
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
