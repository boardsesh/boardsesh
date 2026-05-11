import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  pageleave: vi.fn(),
}));

vi.mock('../analytics', () => ({
  pageleave: mocks.pageleave,
}));

function setScrollMetrics({
  scrollY = 0,
  innerHeight = 800,
  docHeight = 2000,
}: {
  scrollY?: number;
  innerHeight?: number;
  docHeight?: number;
}): void {
  Object.defineProperty(window, 'scrollY', { value: scrollY, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: innerHeight, configurable: true });
  Object.defineProperty(document.documentElement, 'scrollHeight', { value: docHeight, configurable: true });
  Object.defineProperty(document.body, 'scrollHeight', { value: docHeight, configurable: true });
}

describe('analytics page tracker', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const tracker = await import('../analytics-page-tracker');
    tracker.__testing.reset();
    setScrollMetrics({ scrollY: 0, innerHeight: 800, docHeight: 2000 });
  });

  afterEach(async () => {
    const tracker = await import('../analytics-page-tracker');
    tracker.__testing.reset();
  });

  it('does not fire $pageleave on the first pageview (no previous page)', async () => {
    const { startPageview } = await import('../analytics-page-tracker');

    const prev = startPageview('/');

    expect(prev).toBeNull();
    expect(mocks.pageleave).not.toHaveBeenCalled();
  });

  it('fires $pageleave for the previous page and returns its prev-pageview properties', async () => {
    const { startPageview, __testing } = await import('../analytics-page-tracker');

    startPageview('/b/kilter');

    setScrollMetrics({ scrollY: 600, innerHeight: 800, docHeight: 2000 });
    __testing.snapshotScroll();

    const prev = startPageview('/b/tension');

    expect(prev).toEqual({
      $prev_pageview_pathname: '/b/kilter',
      $prev_pageview_max_scroll: 600,
      $prev_pageview_last_scroll: 600,
      $prev_pageview_max_scroll_percentage: 0.5, // 600 / (2000 - 800)
      $prev_pageview_last_scroll_percentage: 0.5,
      $prev_pageview_max_content: 1400, // 600 + 800
      $prev_pageview_last_content: 1400,
      $prev_pageview_max_content_percentage: 0.7, // 1400 / 2000
      $prev_pageview_last_content_percentage: 0.7,
    });
    expect(mocks.pageleave).toHaveBeenCalledWith(
      '/b/kilter',
      expect.objectContaining({
        $prev_pageview_pathname: '/b/kilter',
        $prev_pageview_max_scroll_percentage: 0.5,
      }),
    );
  });

  it('tracks scroll as a max — never decreases when the user scrolls back up', async () => {
    const { startPageview, __testing } = await import('../analytics-page-tracker');

    startPageview('/long-article');

    setScrollMetrics({ scrollY: 1000, innerHeight: 800, docHeight: 3000 });
    __testing.snapshotScroll();
    setScrollMetrics({ scrollY: 200, innerHeight: 800, docHeight: 3000 });
    __testing.snapshotScroll();

    const state = __testing.getState();
    expect(state.maxScrollPx).toBe(1000);
    expect(state.lastScrollPx).toBe(200);
  });

  it('returns null percentages when the page is not scrollable', async () => {
    const { startPageview, __testing } = await import('../analytics-page-tracker');

    startPageview('/short');

    setScrollMetrics({ scrollY: 0, innerHeight: 800, docHeight: 600 });
    __testing.snapshotScroll();

    const prev = startPageview('/next');

    expect(prev?.$prev_pageview_max_scroll_percentage).toBeNull();
    expect(prev?.$prev_pageview_last_scroll_percentage).toBeNull();
  });

  it('fires $pageleave on pagehide via emitPageleaveIfPending and is idempotent', async () => {
    const { startPageview, emitPageleaveIfPending, __testing } = await import('../analytics-page-tracker');

    startPageview('/b/kilter');
    setScrollMetrics({ scrollY: 400, innerHeight: 800, docHeight: 2000 });
    __testing.snapshotScroll();

    emitPageleaveIfPending();
    emitPageleaveIfPending();

    expect(mocks.pageleave).toHaveBeenCalledTimes(1);
    expect(mocks.pageleave).toHaveBeenCalledWith(
      '/b/kilter',
      expect.objectContaining({
        $prev_pageview_pathname: '/b/kilter',
      }),
    );
  });

  it('skips $pageleave when leaving an admin page', async () => {
    const { startPageview, emitPageleaveIfPending } = await import('../analytics-page-tracker');

    startPageview('/admin/retention');
    emitPageleaveIfPending();

    expect(mocks.pageleave).not.toHaveBeenCalled();
  });

  it('does not fire $pageleave for an admin → non-admin transition (admin was never tracked)', async () => {
    const { startPageview } = await import('../analytics-page-tracker');

    startPageview('/admin/retention');
    const prev = startPageview('/b/kilter');

    expect(prev).toBeNull();
    expect(mocks.pageleave).not.toHaveBeenCalled();
  });

  it('does not return prev-pageview properties when entering an admin page', async () => {
    const { startPageview, __testing } = await import('../analytics-page-tracker');

    startPageview('/b/kilter');
    setScrollMetrics({ scrollY: 600, innerHeight: 800, docHeight: 2000 });
    __testing.snapshotScroll();

    const prev = startPageview('/admin/retention');

    expect(prev).toBeNull();
    expect(mocks.pageleave).toHaveBeenCalledWith('/b/kilter', expect.anything());
  });

  it('attachLifecycleListeners is idempotent', async () => {
    const { attachLifecycleListeners, __testing } = await import('../analytics-page-tracker');
    const addSpy = vi.spyOn(window, 'addEventListener');

    attachLifecycleListeners();
    const callCountAfterFirst = addSpy.mock.calls.length;
    attachLifecycleListeners();

    expect(__testing.getState().listenersAttached).toBe(true);
    expect(addSpy.mock.calls.length).toBe(callCountAfterFirst);

    addSpy.mockRestore();
  });
});
