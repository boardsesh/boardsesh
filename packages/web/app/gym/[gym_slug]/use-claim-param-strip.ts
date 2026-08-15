'use client';

import { useEffect } from 'react';
import { CLAIM_PARAM } from './gym-claim-cta-logic';

/**
 * Drops `?claim=1` from the address bar once the return-from-auth hop is done.
 *
 * Deferred to a macrotask on purpose. Next installs its `pushState`/
 * `replaceState` patch in the root `Router`'s own mount effect
 * (`next/dist/client/components/app-router.js`), and React flushes passive
 * effects child-first — so on the hydration commit this island's effect runs
 * while `window.history.replaceState` is still the **native** one. Calling that
 * directly breaks two things:
 *
 * - it overwrites the entry's state, dropping Next's `{ __NA, … }`, and
 *   `onPopState` bails on `if (!event.state) return` — a later Back moves the
 *   address bar without moving the rendered page; and
 * - it never runs `applyUrlFromHistoryPushReplace`, so the router's
 *   `canonicalUrl` keeps `?claim=1` and the next `HistoryUpdater` insertion
 *   effect writes the param straight back. That is reachable on the happy
 *   path — an auto-approved domain claim calls `router.refresh()`.
 *
 * Passing `window.history.state` instead of `null` fixes only the first half:
 * the patch short-circuits on `data.__NA` and skips the canonical-URL update.
 * Waiting a tick means the patched `replaceState` handles the call and does
 * both — and unlike `router.replace`, it refetches no RSC payload, so the
 * island (and any dialog it has open) is not remounted.
 */
export function useClaimParamStrip(active: boolean): void {
  useEffect(() => {
    if (!active) return;

    const timer = setTimeout(() => {
      const currentUrl = new URL(window.location.href);
      currentUrl.searchParams.delete(CLAIM_PARAM);
      window.history.replaceState(null, '', `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
    }, 0);

    return () => clearTimeout(timer);
  }, [active]);
}
