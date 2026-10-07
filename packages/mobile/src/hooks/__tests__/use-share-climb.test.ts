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
// `text()` is here because the prewarm reads the page to find the card an
// unfurler will actually ask for, rather than guessing at its URL.
type PrewarmResponse = { ok: boolean; text: () => Promise<string> };
const fetchMock = vi.fn<(input: string, init?: { signal?: AbortSignal }) => Promise<PrewarmResponse>>(async () => ({
  ok: true,
  text: async () => '',
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
  CLIMB_SHARE_BASE_URL: 'https://www.boardsesh.com',
  BACKEND_URL: 'https://ws.boardsesh.com',
}));

import { useShareClimb } from '../use-share-climb';
import { clearSprayWallRegistry, registerSprayWall } from '../../lib/spray/spray-wall-registry';

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
//
// No climb identity here on purpose: the app cannot reproduce the canonical
// angle or the text normalisation www uses, so a near-miss would warm a second
// entry rather than the right one — verified against production, where the same
// climb at /25/, /40/ and /50/ all advertise `angle=40`.
//
// What it warms is the per-board base, shared with the card an unfurler asks
// for. The card itself is read off the page; see `share-prewarm.test.ts`.
const expectedOgImageUrl =
  'https://ws.boardsesh.com/og/climb?board_name=kilter&layout_id=1&size_id=7&set_ids=1%2C20&frames=p1145r15p1146r12&format=jpeg&render_mode=aura&field_color=%23181225';

describe('useShareClimb', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ctrl.os = 'ios';
    fetchMock.mockResolvedValue({ ok: true, text: async () => '' });
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
      expect(fetchMock).toHaveBeenCalledWith(expectedReadableShareUrl, expect.anything());
      // Exactly one warm: the no-frames climb has no backdrop url to warm.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(shareMock).toHaveBeenCalledTimes(1);
    });

    it('warms the backend og image url too when the climb has frames', async () => {
      const { result } = renderHook(() => useShareClimb({ climb: climbWithFrames, ...baseArgs }));
      await act(async () => {
        await result.current();
      });
      // Backdrop first, then the page. Reading the page costs a whole body
      // download, and gating the backdrop on that leaves the backend idle for
      // all of it while the share sheet is already open.
      expect(fetchMock).toHaveBeenNthCalledWith(1, expectedOgImageUrl);
      expect(fetchMock).toHaveBeenNthCalledWith(2, expectedReadableShareUrl, expect.anything());
    });

    it('warms the card the page advertises, which is the one an unfurler fetches', async () => {
      const advertised = `${expectedOgImageUrl}&n=Test+Climb&g=V4&s=someone&angle=40`;
      fetchMock.mockImplementation(async (input: string) => ({
        ok: true,
        text: async () =>
          input === expectedReadableShareUrl
            ? `<head><meta property="og:image" content="${advertised.replaceAll('&', '&amp;')}"/></head>`
            : '',
      }));

      const { result } = renderHook(() => useShareClimb({ climb: climbWithFrames, ...baseArgs }));
      await act(async () => {
        await result.current();
      });

      // Polled rather than asserted straight after `act`. The prewarm is
      // deliberately not awaited by the hook, so whether its microtask chain has
      // drained by the time `act` returns is not something this test should be
      // betting on — it would fail intermittently rather than wrongly pass.
      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(advertised);
      });
    });

    it('sorts unsorted set_ids in the warmed og url', async () => {
      const { result } = renderHook(() => useShareClimb({ climb: climbWithFrames, ...baseArgs, setIds: '20,1' }));
      await act(async () => {
        await result.current();
      });
      expect(fetchMock).toHaveBeenNthCalledWith(1, expectedOgImageUrl);
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

  // #5488: a spray wall has no config-tuple URL www can render (`/spray/...`
  // 404s there), so the link has to be the wall's `/b/{slug}` view.
  describe('spray wall', () => {
    const SPRAY_LAYOUT_ID = 4321;
    const sprayArgs = {
      boardName: 'spray',
      layoutId: SPRAY_LAYOUT_ID,
      sizeId: SPRAY_LAYOUT_ID,
      setIds: '1',
      angle: 25,
    };
    const sprayClimb = {
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      name: 'Blue Traverse',
      frames: 'p12r42',
    } as unknown as Parameters<typeof useShareClimb>[0]['climb'];

    function registerWall(flags: { isPublic: boolean; isUnlisted: boolean } | null) {
      registerSprayWall(SPRAY_LAYOUT_ID, {
        wallUuid: '11111111-2222-3333-4444-555555555555',
        angle: 40,
        version: 1,
        versionId: 1,
        photoWidth: 1200,
        photoHeight: 1600,
        photoUrl: 'https://private.example/photo',
        photoThumbUrl: null,
        photoExpiresAt: '2099-01-01T00:00:00.000Z',
        holds: [],
        share: flags ? { slug: 'brewery-spray', ...flags } : null,
      });
    }

    afterEach(() => {
      clearSprayWallRegistry();
    });

    async function shareOnce() {
      const { result } = renderHook(() => useShareClimb({ climb: sprayClimb, ...sprayArgs }));
      await act(async () => {
        await result.current();
      });
      const firstCall = shareMock.mock.calls[0];
      if (!firstCall) throw new Error('Share.share was not called');
      return firstCall[0];
    }

    it("shares a public wall's climb as its /b/ view at the wall's own angle", async () => {
      registerWall({ isPublic: true, isUnlisted: false });
      const payload = await shareOnce();
      const expected =
        'https://www.boardsesh.com/b/brewery-spray/40/view/blue-traverse-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      expect(payload).toEqual({ message: 'Blue Traverse', url: expected });
      // The public card is warmed with exactly the URL www advertises.
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        `https://ws.boardsesh.com/og/climb?board_name=spray&layout_id=${SPRAY_LAYOUT_ID}&size_id=${SPRAY_LAYOUT_ID}&set_ids=1&frames=p12r42&format=jpeg`,
      );
      expect(fetchMock).toHaveBeenNthCalledWith(2, expected, expect.anything());
    });

    it('carries the wall capability for an unlisted wall and warms no card', async () => {
      registerWall({ isPublic: false, isUnlisted: true });
      const payload = await shareOnce();
      expect(payload).toEqual({
        message: 'Blue Traverse',
        url: 'https://www.boardsesh.com/b/brewery-spray/40/view/blue-traverse-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee?wall=11111111-2222-3333-4444-555555555555',
      });
      // Only the page: an unlisted wall has no card to warm.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('shares the name alone for a private wall, never a link that 404s', async () => {
      registerWall({ isPublic: false, isUnlisted: false });
      expect(await shareOnce()).toEqual({ message: 'Blue Traverse' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('shares the name alone when the wall is not loaded or carries no slug', async () => {
      expect(await shareOnce()).toEqual({ message: 'Blue Traverse' });
      shareMock.mockClear();
      registerWall(null);
      expect(await shareOnce()).toEqual({ message: 'Blue Traverse' });
      expect(fetchMock).not.toHaveBeenCalled();
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
