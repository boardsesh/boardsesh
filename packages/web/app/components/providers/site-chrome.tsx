'use client';

import React from 'react';
import { StatsFilterBridgeProvider } from '../stats-filter-bridge/stats-filter-bridge-context';
import { ProfileHeaderShareProvider } from '../profile-header-bridge/profile-header-bridge-context';
import PlaylistsAdapterProvider from './playlists-adapter-provider';
import MarketingHeader from '../site-chrome/marketing-header';
import SiteFooter from '../site-chrome/site-footer';

/**
 * Root chrome for www.
 *
 * Replaces the old `PersistentSessionWrapper`, which mounted the whole
 * interactive climbing stack — a party-session WebSocket, the queue bridge, the
 * BLE provider, the queue control bar and the bottom tab bar — on *every*
 * route, `/about` and `/legal` included. Climbing lives in the app now, so the
 * root keeps only what the surviving marketing and account surfaces need:
 *
 *  - `StatsFilterBridgeProvider` — the profile/`/you` statistics filter button
 *    in the header talks to the page through this bridge.
 *  - `ProfileHeaderShareProvider` — the viewed-profile share button, same shape.
 *  - `PlaylistsAdapterProvider` — required, not optional: every hook in
 *    `@boardsesh/playlists-react` calls `usePlaylistsAdapter()` unconditionally,
 *    so `/playlists` and `/playlists/[uuid]` throw without it.
 *
 * `AuthModalProvider` deliberately stays where it already is in
 * `app/layout.tsx` — it was never inside the old wrapper, and moving it under
 * `FeatureFlagsProvider` would reorder providers for no gain.
 */
export default function SiteChrome({
  children,
  showBuildPlans = false,
}: {
  children: React.ReactNode;
  /**
   * Server-resolved `cnc-packs` gate, passed straight through to SiteFooter.
   * SiteChrome itself is a client component and must not resolve it — see the
   * note at the call site in app/layout.tsx.
   */
  showBuildPlans?: boolean;
}) {
  return (
    <StatsFilterBridgeProvider>
      <ProfileHeaderShareProvider>
        <PlaylistsAdapterProvider>
          <MarketingHeader />
          {children}
          <SiteFooter showBuildPlans={showBuildPlans} />
        </PlaylistsAdapterProvider>
      </ProfileHeaderShareProvider>
    </StatsFilterBridgeProvider>
  );
}
