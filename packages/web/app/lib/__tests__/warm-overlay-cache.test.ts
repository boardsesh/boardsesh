import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

// Isolate the warming logic from the real URL builders — the test only cares
// which URLs get fetched, not how they're assembled.
vi.mock('@/app/components/board-renderer/util', () => ({
  buildBoardArtLayers: vi.fn(() => ({ backgroundUrls: [], overlayUrl: '/api/internal/board-render?overlay' })),
  buildOgBoardRenderUrl: vi.fn(() => 'https://ws.boardsesh.com/og/climb?og'),
}));

const headersMock = vi.hoisted(() => vi.fn());
vi.mock('next/headers', () => ({ headers: headersMock }));

import { FRONT_DOOR_WARM_LIMIT, scheduleOverlayWarming, warmOverlays } from '../warm-overlay-cache';
import { buildOgBoardRenderUrl } from '@/app/components/board-renderer/util';

type WarmOverlaysArg = Parameters<typeof warmOverlays>[0];
const boardDetails = { board_name: 'kilter' } as unknown as WarmOverlaysArg['boardDetails'];
const climbs = [{ frames: 'p1r12p2r13' }];

describe('warmOverlays', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(buildOgBoardRenderUrl).mockReturnValue('https://ws.boardsesh.com/og/climb?og');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ body: null }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('warms both the overlay and the absolute og image on the full climb-view path', async () => {
    await warmOverlays({ boardDetails, climbs, variant: 'full' });

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/internal/board-render?overlay'),
      expect.anything(),
    );
    expect(fetch).toHaveBeenCalledWith('https://ws.boardsesh.com/og/climb?og', expect.anything());
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('warms only the overlay for a thumbnail list — no per-row og render', async () => {
    await warmOverlays({ boardDetails, climbs, variant: 'thumbnail' });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/internal/board-render?overlay'),
      expect.anything(),
    );
    expect(buildOgBoardRenderUrl).not.toHaveBeenCalled();
  });

  it('skips the relative og fallback (backend origin unresolvable)', async () => {
    vi.mocked(buildOgBoardRenderUrl).mockReturnValue('/api/og/climb?relative');

    await warmOverlays({ boardDetails, climbs, variant: 'full' });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalledWith('/api/og/climb?relative', expect.anything());
  });

  it('swallows fetch failures instead of rejecting', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network down'));

    await expect(warmOverlays({ boardDetails, climbs, variant: 'full' })).resolves.toBeUndefined();
  });

  it('warms only FRONT_DOOR_WARM_LIMIT rows of a full list page', async () => {
    const fiftyClimbs = Array.from({ length: 50 }, (_, index) => ({ frames: `p1r${index}` }));

    await warmOverlays({ boardDetails, climbs: fiftyClimbs, variant: 'thumbnail', maxImages: FRONT_DOOR_WARM_LIMIT });

    // Each warm target is a same-origin CPU-bound WASM render. 50 rows at the
    // old default of 20 made one crawled list page cost 20 extra invocations.
    expect(FRONT_DOOR_WARM_LIMIT).toBe(6);
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it('bounds every warm fetch with an abort signal', async () => {
    await warmOverlays({ boardDetails, climbs, variant: 'thumbnail' });

    // A warm request that never settles keeps the serverless instance — and the
    // pool connections it is holding — alive past the response it rode in on.
    const [, requestInit] = vi.mocked(fetch).mock.calls[0];
    expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('scheduleOverlayWarming', () => {
  /** Let the fire-and-forget chain inside `scheduleOverlayWarming` settle. */
  const flushWarming = () => new Promise((resolve) => setImmediate(resolve));

  const withUserAgent = (userAgentHeader: string | null) =>
    headersMock.mockReturnValue(Promise.resolve({ get: () => userAgentHeader }));

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(buildOgBoardRenderUrl).mockReturnValue('https://ws.boardsesh.com/og/climb?og');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ body: null }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('warms for a human visitor', async () => {
    withUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/126.0.0.0 Safari/537.36');

    scheduleOverlayWarming({ boardDetails, climbs, variant: 'full' });
    await flushWarming();

    expect(fetch).toHaveBeenCalled();
  });

  // The whole point of the gate: a crawler renders the page and never fetches
  // the image, so every warm it triggers is a wasted 3 GB WASM+sharp render.
  it.each([
    ['Googlebot', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'],
    ['AhrefsBot', 'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)'],
    ['SemrushBot', 'Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)'],
  ])('skips warming for %s', async (_name, userAgentHeader) => {
    withUserAgent(userAgentHeader);

    scheduleOverlayWarming({ boardDetails, climbs, variant: 'full' });
    await flushWarming();

    expect(fetch).not.toHaveBeenCalled();
  });

  // Fails closed — see the doc comment on `warmUnlessCrawler`. A false skip
  // costs one on-demand LCP render; a false warm costs the invocation the gate
  // exists to remove.
  it('skips warming when there is no request scope', async () => {
    headersMock.mockImplementation(() => {
      throw new Error('`headers` was called outside a request scope');
    });

    scheduleOverlayWarming({ boardDetails, climbs, variant: 'full' });
    await flushWarming();

    expect(fetch).not.toHaveBeenCalled();
  });

  it('skips warming when the header read rejects', async () => {
    headersMock.mockReturnValue(Promise.reject(new Error('dynamic API not available')));

    scheduleOverlayWarming({ boardDetails, climbs, variant: 'full' });
    await flushWarming();

    expect(fetch).not.toHaveBeenCalled();
  });

  it('warms when the request carries no user-agent at all', async () => {
    withUserAgent(null);

    scheduleOverlayWarming({ boardDetails, climbs, variant: 'full' });
    await flushWarming();

    expect(fetch).toHaveBeenCalled();
  });
});

describe('the origin warm fetches are aimed at', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ body: null }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function warmedOverlayUrl(): string {
    const overlayCall = vi.mocked(fetch).mock.calls.find(([url]) => String(url).includes('/api/internal/board-render'));
    return String(overlayCall?.[0]);
  }

  function expectOriginIs(warmedUrl: string, expectedOrigin: string): void {
    expect(new URL(warmedUrl).origin).toBe(expectedOrigin);
  }

  function stubOriginEnv(overrides: Partial<Record<'BASE_URL' | 'NEXTAUTH_URL' | 'VERCEL_URL', string>>) {
    vi.stubEnv('BASE_URL', overrides.BASE_URL ?? '');
    vi.stubEnv('NEXTAUTH_URL', overrides.NEXTAUTH_URL ?? '');
    vi.stubEnv('VERCEL_URL', overrides.VERCEL_URL ?? '');
  }

  it('uses a configured https BASE_URL, on any host', async () => {
    stubOriginEnv({ BASE_URL: 'https://www.boardsesh.com' });
    await warmOverlays({ boardDetails, climbs, variant: 'thumbnail' });
    expectOriginIs(warmedOverlayUrl(), 'https://www.boardsesh.com');
  });

  it('falls back to the canonical NEXTAUTH_URL when BASE_URL names nothing', async () => {
    stubOriginEnv({ NEXTAUTH_URL: 'https://www.boardsesh.com' });
    await warmOverlays({ boardDetails, climbs, variant: 'thumbnail' });
    expectOriginIs(warmedOverlayUrl(), 'https://www.boardsesh.com');
  });

  it('ignores a loopback origin variable rather than warming localhost from a real host', async () => {
    // The bug shape: `VERCEL_URL ? SITE_URL : 'http://localhost:3000'` sent every
    // warm fetch on a non-Vercel host to a loopback port nothing is listening on,
    // on the hot SSR path of every list and climb-view render (#4651). The
    // tracked packages/web/.env.local supplies exactly this loopback BASE_URL, so
    // an https NEXTAUTH_URL has to win over it.
    stubOriginEnv({ BASE_URL: 'http://localhost:3000', NEXTAUTH_URL: 'https://www.boardsesh.com' });
    await warmOverlays({ boardDetails, climbs, variant: 'thumbnail' });
    expectOriginIs(warmedOverlayUrl(), 'https://www.boardsesh.com');
  });

  it('still uses the site URL on Vercel, and localhost in local dev', async () => {
    stubOriginEnv({ VERCEL_URL: 'boardsesh-abc.vercel.app' });
    await warmOverlays({ boardDetails, climbs, variant: 'thumbnail' });
    expectOriginIs(warmedOverlayUrl(), 'https://www.boardsesh.com');

    vi.mocked(fetch).mockClear();
    stubOriginEnv({ NEXTAUTH_URL: 'http://localhost:3000' });
    await warmOverlays({ boardDetails, climbs, variant: 'thumbnail' });
    expectOriginIs(warmedOverlayUrl(), 'http://localhost:3000');
  });
});
