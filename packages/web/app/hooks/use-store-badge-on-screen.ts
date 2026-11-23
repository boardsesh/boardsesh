'use client';

import { useEffect, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';

/**
 * The page's official store badges: every anchor `StoreInstallButtons` renders
 * carries `data-store-badge="ios|android"`, and so does any other surface that
 * shows a badge. Selected by the attribute, not by component, so a new badge
 * surface counts without touching this hook. Only `<main>`: the header and the
 * footer are not the page's own install block.
 */
export const STORE_BADGE_SELECTOR = 'main a[data-store-badge]';

/** Whether a node that came or went is a badge, or holds one. */
function holdsBadge(node: Node): boolean {
  if (!(node instanceof Element)) return false;
  return node.matches('a[data-store-badge]') || node.querySelector('a[data-store-badge]') !== null;
}

/**
 * Where a badge is right now, measured on the spot: for a badge that has just
 * arrived, so the answer is right before the next paint rather than one
 * IntersectionObserver report later. A `display: none` badge has an empty box.
 */
function onScreenNow(badge: Element, headerHeight: number): boolean {
  const box = badge.getBoundingClientRect();
  return box.height > 0 && box.bottom > headerHeight && box.top < window.innerHeight;
}

/**
 * Whether any store badge in `<main>` is on screen right now, below the fixed
 * header (`headerRef`): a badge that has scrolled up under the header counts as
 * gone. `null` on the server and the hydration render, before the browser has
 * been asked: the caller keeps its CSS guess until then.
 *
 * A `display: none` badge never counts: it has an empty box. That is the
 * laptop-only QR card's badges on a phone, and the phone hero's on a laptop.
 *
 * The header's height is `max(8dvh, 48px)` plus the safe-area inset, so it
 * changes when a phone rotates or its URL bar collapses. The band a badge hides
 * under follows it: a change rebuilds the IntersectionObserver with the new
 * inset.
 *
 * The header outlives client-side navigation and pages stream content in after
 * mount (`<Suspense>`), so this watches the whole `<body>` for badges that
 * arrive or leave, rather than one `<main>`: each page brings its own `<main>`.
 * A badge that arrives is measured at once, and that answer is committed
 * synchronously (`flushSync`), so it reaches the screen in the same frame as the
 * page that brought the badge: the new page never paints with the old page's
 * answer. A caller that was showing on the old page can still fade out as the
 * new one appears.
 */
export function useStoreBadgeOnScreen(headerRef: RefObject<HTMLElement | null>): boolean | null {
  const [onScreen, setOnScreen] = useState<boolean | null>(null);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined' || typeof MutationObserver === 'undefined') {
      // No way to tell: behave as before, with the caller's action showing.
      setOnScreen(false);
      return;
    }

    // Set by the cleanup: a report the browser queued before the disconnect must not land.
    let disposed = false;
    const badges = new Map<Element, boolean>();
    const settle = () => {
      if (!disposed) setOnScreen([...badges.values()].some(Boolean));
    };

    // The header is fixed at the top, so its height is the band a badge is hidden under.
    const measureHeader = () => Math.round(headerRef.current?.getBoundingClientRect().height ?? 0);
    let headerHeight = measureHeader();

    const watchBadges = () => {
      const observer = new IntersectionObserver(
        (entries) => {
          if (disposed) return;
          for (const entry of entries) {
            // Reported after the badge left the page: forget it, don't resurrect it.
            if (!badges.has(entry.target)) continue;
            badges.set(entry.target, entry.isIntersecting && entry.boundingClientRect.height > 0);
          }
          settle();
        },
        { rootMargin: `-${headerHeight}px 0px 0px 0px` },
      );
      for (const badge of badges.keys()) observer.observe(badge);
      return observer;
    };
    let badgeObserver = watchBadges();

    const rescan = () => {
      const current = new Set(document.querySelectorAll(STORE_BADGE_SELECTOR));
      for (const badge of badges.keys()) {
        if (current.has(badge)) continue;
        badgeObserver.unobserve(badge);
        badges.delete(badge);
      }
      for (const badge of current) {
        if (badges.has(badge)) continue;
        badges.set(badge, onScreenNow(badge, headerHeight));
        badgeObserver.observe(badge);
      }
    };
    // In a passive effect, where flushSync is not allowed: the caller's CSS guess
    // covers the frames until this commits.
    rescan();
    settle();

    const badgeWatcher = new MutationObserver((mutations) => {
      if (disposed) return;
      const badgesMoved = mutations.some(
        (mutation) => [...mutation.addedNodes].some(holdsBadge) || [...mutation.removedNodes].some(holdsBadge),
      );
      if (!badgesMoved) return;
      rescan();
      // A microtask after React's commit, outside rendering: safe to flush, and
      // it keeps the answer out of the next paint's way.
      flushSync(settle);
    });
    badgeWatcher.observe(document.body, { childList: true, subtree: true });

    // Rotation and the URL bar move the header's bottom edge: rebuild the
    // observer around the new inset. Its first report re-measures every badge.
    const onHeaderResize = () => {
      if (disposed) return;
      const nextHeight = measureHeader();
      if (nextHeight === headerHeight) return;
      headerHeight = nextHeight;
      badgeObserver.disconnect();
      badgeObserver = watchBadges();
    };
    const header = headerRef.current;
    let headerWatcher: ResizeObserver | null = null;
    if (header && typeof ResizeObserver !== 'undefined') {
      headerWatcher = new ResizeObserver(onHeaderResize);
      headerWatcher.observe(header, { box: 'border-box' });
    } else {
      window.addEventListener('resize', onHeaderResize);
    }

    return () => {
      disposed = true;
      badgeObserver.disconnect();
      badgeWatcher.disconnect();
      if (headerWatcher) headerWatcher.disconnect();
      else window.removeEventListener('resize', onHeaderResize);
    };
  }, [headerRef]);

  return onScreen;
}
