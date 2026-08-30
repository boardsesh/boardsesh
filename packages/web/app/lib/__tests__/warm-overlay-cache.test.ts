import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('@/app/components/board-renderer/util', () => ({
  buildOgBoardRenderUrl: vi.fn(() => 'https://ws.boardsesh.com/og/climb?og'),
}));

const headersMock = vi.hoisted(() => vi.fn());
vi.mock('next/headers', () => ({ headers: headersMock }));

import { scheduleOgImageWarming, warmOgImage } from '../warm-overlay-cache';
import { buildOgBoardRenderUrl } from '@/app/components/board-renderer/util';

type WarmOgImageArg = Parameters<typeof warmOgImage>[0];
const boardDetails = { board_name: 'kilter' } as unknown as WarmOgImageArg['boardDetails'];
const climb = { frames: 'p1r12p2r13' };

describe('warmOgImage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(buildOgBoardRenderUrl).mockReturnValue('https://ws.boardsesh.com/og/climb?og');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ body: null }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('warms exactly the absolute backend OG image', async () => {
    await warmOgImage({ boardDetails, climb });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('https://ws.boardsesh.com/og/climb?og', expect.anything());
  });

  it('skips the relative fallback when the public backend origin is unavailable', async () => {
    vi.mocked(buildOgBoardRenderUrl).mockReturnValue('/api/og/climb?relative');

    await warmOgImage({ boardDetails, climb });

    expect(fetch).not.toHaveBeenCalled();
  });

  it('swallows fetch failures instead of rejecting', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network down'));

    await expect(warmOgImage({ boardDetails, climb })).resolves.toBeUndefined();
  });

  it('bounds the warm with an abort signal', async () => {
    await warmOgImage({ boardDetails, climb });

    const [, requestInit] = vi.mocked(fetch).mock.calls[0];
    expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('scheduleOgImageWarming', () => {
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
    withUserAgent('Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36');

    scheduleOgImageWarming({ boardDetails, climb });
    await flushWarming();

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Googlebot', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'],
    ['AhrefsBot', 'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)'],
    ['SemrushBot', 'Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)'],
  ])('skips warming for %s', async (_name, userAgentHeader) => {
    withUserAgent(userAgentHeader);

    scheduleOgImageWarming({ boardDetails, climb });
    await flushWarming();

    expect(fetch).not.toHaveBeenCalled();
  });

  it('skips warming without a request scope', async () => {
    headersMock.mockImplementation(() => {
      throw new Error('headers called outside request scope');
    });

    scheduleOgImageWarming({ boardDetails, climb });
    await flushWarming();

    expect(fetch).not.toHaveBeenCalled();
  });

  it('skips warming when the header read rejects', async () => {
    headersMock.mockReturnValue(Promise.reject(new Error('dynamic API unavailable')));

    scheduleOgImageWarming({ boardDetails, climb });
    await flushWarming();

    expect(fetch).not.toHaveBeenCalled();
  });
});
