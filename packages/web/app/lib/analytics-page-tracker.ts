import { pageleave as emitPageleave } from './analytics';
import { isAdminAnalyticsUrl } from './analytics-paths';

export type PrevPageviewProperties = {
  $prev_pageview_pathname: string;
  $prev_pageview_max_scroll: number;
  $prev_pageview_last_scroll: number;
  $prev_pageview_max_scroll_percentage: number | null;
  $prev_pageview_last_scroll_percentage: number | null;
  $prev_pageview_max_content: number;
  $prev_pageview_last_content: number;
  $prev_pageview_max_content_percentage: number | null;
  $prev_pageview_last_content_percentage: number | null;
};

let activePath: string | null = null;
let maxScrollPx = 0;
let lastScrollPx = 0;
let maxContentPx = 0;
let lastContentPx = 0;
let pageleaveSent = false;
let listenersAttached = false;
let rafQueued = false;

function roundPct(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function snapshotScroll(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const scrollY = Math.max(0, Math.round(window.scrollY || 0));
  const viewport = window.innerHeight || 0;
  const docHeight = Math.max(document.documentElement?.scrollHeight ?? 0, document.body?.scrollHeight ?? 0);
  const content = Math.min(scrollY + viewport, docHeight || scrollY + viewport);

  lastScrollPx = scrollY;
  lastContentPx = content;
  if (scrollY > maxScrollPx) maxScrollPx = scrollY;
  if (content > maxContentPx) maxContentPx = content;
}

function buildPrevPageviewProperties(): PrevPageviewProperties | null {
  if (!activePath) return null;
  snapshotScroll();

  const docHeight =
    typeof document !== 'undefined'
      ? Math.max(document.documentElement?.scrollHeight ?? 0, document.body?.scrollHeight ?? 0)
      : 0;
  const viewport = typeof window !== 'undefined' ? window.innerHeight || 0 : 0;
  const scrollable = Math.max(0, docHeight - viewport);

  return {
    $prev_pageview_pathname: activePath,
    $prev_pageview_max_scroll: maxScrollPx,
    $prev_pageview_last_scroll: lastScrollPx,
    $prev_pageview_max_scroll_percentage: scrollable > 0 ? roundPct(maxScrollPx / scrollable) : null,
    $prev_pageview_last_scroll_percentage: scrollable > 0 ? roundPct(lastScrollPx / scrollable) : null,
    $prev_pageview_max_content: maxContentPx,
    $prev_pageview_last_content: lastContentPx,
    $prev_pageview_max_content_percentage: docHeight > 0 ? roundPct(maxContentPx / docHeight) : null,
    $prev_pageview_last_content_percentage: docHeight > 0 ? roundPct(lastContentPx / docHeight) : null,
  };
}

function resetForPath(pathname: string | null): void {
  activePath = pathname;
  maxScrollPx = 0;
  lastScrollPx = 0;
  maxContentPx = 0;
  lastContentPx = 0;
  pageleaveSent = false;
}

export function startPageview(pathname: string): PrevPageviewProperties | null {
  let prev: PrevPageviewProperties | null = null;

  const prevPath = activePath;
  const prevWasTrackable = prevPath !== null && !isAdminAnalyticsUrl(prevPath);
  const newIsTrackable = !isAdminAnalyticsUrl(pathname);

  if (prevPath && prevPath !== pathname && !pageleaveSent && prevWasTrackable) {
    prev = buildPrevPageviewProperties();
    if (prev) {
      emitPageleave(prevPath, prev as unknown as Record<string, string | number | boolean | null>);
    }
  }

  resetForPath(pathname);
  return newIsTrackable ? prev : null;
}

export function emitPageleaveIfPending(): void {
  if (!activePath || pageleaveSent) return;
  if (isAdminAnalyticsUrl(activePath)) {
    pageleaveSent = true;
    return;
  }
  const prev = buildPrevPageviewProperties();
  if (!prev) return;
  emitPageleave(activePath, prev as unknown as Record<string, string | number | boolean | null>);
  pageleaveSent = true;
}

function handleScroll(): void {
  if (rafQueued) return;
  rafQueued = true;
  window.requestAnimationFrame(() => {
    rafQueued = false;
    snapshotScroll();
  });
}

function handlePagehide(): void {
  emitPageleaveIfPending();
}

function handlePageshow(): void {
  // bfcache restore — allow the next exit to fire $pageleave again.
  pageleaveSent = false;
}

function handleVisibility(): void {
  if (typeof document === 'undefined') return;
  if (document.visibilityState === 'hidden') {
    emitPageleaveIfPending();
  } else if (document.visibilityState === 'visible') {
    pageleaveSent = false;
  }
}

export function attachLifecycleListeners(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (listenersAttached) return;
  listenersAttached = true;

  window.addEventListener('scroll', handleScroll, { passive: true });
  window.addEventListener('resize', handleScroll, { passive: true });
  window.addEventListener('pagehide', handlePagehide);
  window.addEventListener('pageshow', handlePageshow);
  document.addEventListener('visibilitychange', handleVisibility);
}

export const __testing = {
  reset(): void {
    activePath = null;
    maxScrollPx = 0;
    lastScrollPx = 0;
    maxContentPx = 0;
    lastContentPx = 0;
    pageleaveSent = false;
    listenersAttached = false;
    rafQueued = false;
  },
  snapshotScroll,
  getState(): {
    activePath: string | null;
    maxScrollPx: number;
    lastScrollPx: number;
    maxContentPx: number;
    lastContentPx: number;
    pageleaveSent: boolean;
    listenersAttached: boolean;
  } {
    return {
      activePath,
      maxScrollPx,
      lastScrollPx,
      maxContentPx,
      lastContentPx,
      pageleaveSent,
      listenersAttached,
    };
  },
};
