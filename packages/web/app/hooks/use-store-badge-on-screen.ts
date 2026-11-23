'use client';

import { useEffect, useState, type RefObject } from 'react';

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
 * The header outlives client-side navigation and pages stream content in after
 * mount (`<Suspense>`), so this watches the whole `<body>` for badges that
 * arrive or leave, rather than one `<main>`: each page brings its own `<main>`.
 * A badge that arrives is measured at once, in the same task as the DOM change,
 * so navigating to the home page never shows the caller and then takes it away.
 */
export function useStoreBadgeOnScreen(headerRef: RefObject<HTMLElement | null>): boolean | null {
  const [onScreen, setOnScreen] = useState<boolean | null>(null);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined' || typeof MutationObserver === 'undefined') {
      // No way to tell: behave as before, with the caller's action showing.
      setOnScreen(false);
      return;
    }

    const badges = new Map<Element, boolean>();
    const settle = () => setOnScreen([...badges.values()].some(Boolean));

    // The header is fixed at the top, so its height is the band a badge is hidden under.
    const headerHeight = Math.round(headerRef.current?.getBoundingClientRect().height ?? 0);
    const badgeObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          // Reported after the badge left the page: forget it, don't resurrect it.
          if (!badges.has(entry.target)) continue;
          badges.set(entry.target, entry.isIntersecting && entry.boundingClientRect.height > 0);
        }
        settle();
      },
      { rootMargin: `-${headerHeight}px 0px 0px 0px` },
    );

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
      settle();
    };
    rescan();

    const badgeWatcher = new MutationObserver((mutations) => {
      const badgesMoved = mutations.some(
        (mutation) => [...mutation.addedNodes].some(holdsBadge) || [...mutation.removedNodes].some(holdsBadge),
      );
      if (badgesMoved) rescan();
    });
    badgeWatcher.observe(document.body, { childList: true, subtree: true });

    return () => {
      badgeObserver.disconnect();
      badgeWatcher.disconnect();
    };
  }, [headerRef]);

  return onScreen;
}
