'use client';

import { useSyncExternalStore } from 'react';
import { getSessionInboundCampaign, type InboundCampaign } from '@/app/lib/inbound-campaign';

// The session campaign is read once and never changes, so there is nothing to
// subscribe to.
const subscribeToNothing = (): (() => void) => () => {};
const getServerSnapshot = (): null => null;

/**
 * The campaign this visit landed with, for a store button to carry into its
 * link (`buildStoreUrl({ ..., inbound })`).
 *
 * `null` on the server AND on the hydration render, then the real value. That
 * order is the point: several pages with a store button are served from a
 * shared CDN cache, so their HTML has to be the same for every visitor. The
 * server renders the untagged link, and a tagged visitor's link is upgraded
 * after hydration without a mismatch warning.
 */
export function useInboundCampaign(): InboundCampaign | null {
  return useSyncExternalStore(subscribeToNothing, getSessionInboundCampaign, getServerSnapshot);
}
