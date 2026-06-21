'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useIsomorphicLayoutEffect } from '@/app/lib/hooks/use-isomorphic-layout-effect';
import { usePathnameWithoutLocale } from '@/app/lib/i18n/use-locale-router';
import { PartyProfileProvider } from '../party-manager/party-profile-context';
import { PersistentSessionProvider, usePersistentSession, usePersistentSessionState } from '../persistent-session';
import { useWakeLock } from '../board-bluetooth-control/use-wake-lock';
import { QueueBridgeProvider, useQueueBridgeBoardInfo } from '../queue-control/queue-bridge-context';
import { useCurrentClimb, useQueueList } from '../graphql-queue';
import QueueControlBar from '../queue-control/queue-control-bar';
import QueueControlBarShell from '../queue-control/queue-control-bar-shell';
import BottomTabBar from '../bottom-tab-bar/bottom-tab-bar';
import { BoardProvider, useBoardProvider } from '../board-provider/board-provider-context';
import { ConnectionSettingsProvider } from '../connection-manager/connection-settings-context';
import { WebSocketConnectionProvider } from '../connection-manager/websocket-connection-provider';
import { BluetoothProvider } from '../board-bluetooth-control/bluetooth-context';
import { WebBoardPresenceProvider } from '../board-presence/board-presence-context';
import { BoardPresencePanel } from '../board-presence/board-presence-panel';
import { FavoritesProvider } from '../climb-actions/favorites-batch-context';
import { PlaylistsProvider } from '../climb-actions/playlists-batch-context';
import { useClimbActionsData } from '@/app/hooks/use-climb-actions-data';
import ErrorBoundary from '../error-boundary';
import bottomBarStyles from '../bottom-tab-bar/bottom-bar-wrapper.module.css';
import type { BoardConfigData } from '@/app/lib/server-board-configs';
import { isBoardRoutePath } from '@/app/lib/board-route-paths';
import GlobalHeader from '../global-header/global-header';
import SessionSummaryDialog from '../session-summary/session-summary-dialog';
import { SearchDrawerBridgeProvider } from '../search-drawer/search-drawer-bridge-context';
import { StatsFilterBridgeProvider } from '../stats-filter-bridge/stats-filter-bridge-context';
import { ProfileHeaderShareProvider } from '../profile-header-bridge/profile-header-bridge-context';
import { isNativeApp } from '@/app/lib/ble/capacitor-utils';
import dynamic from 'next/dynamic';
import { SESH_SETTINGS_DRAWER_EVENT } from '../sesh-settings/sesh-settings-drawer-event';
import { BoardSwitchConfirmProvider } from '../board-lock/board-switch-confirm-provider';
import { FeedbackPromptBanner } from '../feedback/feedback-prompt-banner';
import PlaylistsAdapterProvider from './playlists-adapter-provider';

const SeshSettingsDrawer = dynamic(() => import('../sesh-settings/sesh-settings-drawer'), {
  ssr: false,
});

type PersistentSessionWrapperProps = {
  children: React.ReactNode;
  boardConfigs: BoardConfigData;
};

/**
 * Root-level wrapper that provides:
 * 1. PartyProfileProvider - user profile from IndexedDB and NextAuth session
 * 2. PersistentSessionProvider - WebSocket connection management that persists across navigation
 * 3. QueueBridgeProvider - bridges queue context from board routes to the persistent bottom bar
 * 4. RootBottomBar - always-rendered queue control bar + bottom tab bar
 */
export default function PersistentSessionWrapper({ children, boardConfigs }: PersistentSessionWrapperProps) {
  return (
    <PartyProfileProvider>
      <PersistentSessionProvider>
        <QueueBridgeProvider>
          <BoardSwitchConfirmProvider>
            <SearchDrawerBridgeProvider>
              <StatsFilterBridgeProvider>
                <ProfileHeaderShareProvider>
                  {/* WebBoardPresenceProvider wraps the BLE provider so the
                      connect→resolveBoardForSerial and wall-confirm→reportClimb
                      wiring inside BluetoothProvider can read the wall context.
                      Inert (no client, null boardId) until a BLE serial resolves
                      to a board. */}
                  <WebBoardPresenceProvider>
                    <RootBluetoothProvider>
                      <PlaylistsAdapterProvider>
                        <GlobalHeader boardConfigs={boardConfigs} />
                        {children}
                        <RootBottomBar boardConfigs={boardConfigs} />
                        <BoardPresencePanel />
                        <RootSessionSummaryDialog />
                        <RootSeshSettingsDrawer />
                        <SessionWakeLock />
                      </PlaylistsAdapterProvider>
                    </RootBluetoothProvider>
                  </WebBoardPresenceProvider>
                </ProfileHeaderShareProvider>
              </StatsFilterBridgeProvider>
            </SearchDrawerBridgeProvider>
          </BoardSwitchConfirmProvider>
        </QueueBridgeProvider>
      </PersistentSessionProvider>
    </PartyProfileProvider>
  );
}

/**
 * Single, app-wide BluetoothProvider. Mounted once here so the *same* BLE
 * adapter + AutoSender are shared by both the persistent bottom bar (lightbulb,
 * play drawer) and the route page content (climb list, create-climb form) —
 * previously each route layout and the bottom bar mounted their own provider,
 * so a connection made via the lightbulb was invisible to the page content and
 * two dormant AutoSenders/AutoConnectHandlers raced on a last-wins board.
 *
 * boardDetails comes from the queue bridge (null on off-board routes, where BLE
 * stays inert). Living at the root means the connection now persists across
 * route navigation instead of tearing down when a route layout unmounts.
 */
function RootBluetoothProvider({ children }: { children: React.ReactNode }) {
  const { boardDetails, boardUuid } = useQueueBridgeBoardInfo();
  return (
    <BluetoothProvider boardDetails={boardDetails} boardUuid={boardUuid ?? undefined}>
      {children}
    </BluetoothProvider>
  );
}

/**
 * Holds a screen wake lock while a party session is active so the device
 * (especially Android) doesn't sleep mid-session and break the WebSocket
 * or Bluetooth connection.
 */
function SessionWakeLock() {
  const { activeSession } = usePersistentSessionState();
  useWakeLock(activeSession !== null);
  return null;
}

/**
 * Root-level session summary dialog.
 * Consumes sessionSummary/dismissSessionSummary from PersistentSessionContext
 * so session ending works from any page (not just board routes).
 */
function RootSessionSummaryDialog() {
  const {
    sessionSummary,
    sessionSummaryBoardType,
    sessionSummaryHealthKitWorkoutId,
    sessionSummaryAutoFinished,
    dismissSessionSummary,
  } = usePersistentSession();
  return (
    <SessionSummaryDialog
      summary={sessionSummary}
      boardType={sessionSummaryBoardType ?? ''}
      existingWorkoutId={sessionSummaryHealthKitWorkoutId}
      autoFinished={sessionSummaryAutoFinished}
      onDismiss={dismissSessionSummary}
    />
  );
}

/**
 * Root-level sesh settings drawer.
 * Listens for the SESH_SETTINGS_DRAWER_EVENT dispatched by the session header
 * in the queue control bar. Rendered at the root so it works on every page.
 */
function RootSeshSettingsDrawer() {
  const [open, setOpen] = useState(false);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    const handler = () => {
      setRendered(true);
      setOpen(true);
    };
    window.addEventListener(SESH_SETTINGS_DRAWER_EVENT, handler);
    return () => window.removeEventListener(SESH_SETTINGS_DRAWER_EVENT, handler);
  }, []);

  const handleClose = useCallback(() => setOpen(false), []);
  const handleTransitionEnd = useCallback((isOpen: boolean) => {
    if (!isOpen) setRendered(false);
  }, []);

  if (!rendered) return null;

  return <SeshSettingsDrawer open={open} onClose={handleClose} onTransitionEnd={handleTransitionEnd} />;
}

/**
 * Persistent bottom bar rendered at the root level.
 * Always renders — the QueueBridge provides queue context from whichever provider is active.
 * QueueControlBar is only shown when there is an active queue (board details available).
 */
/** Pages where the bottom tab bar is hidden unless there's an active queue */
const HIDE_TAB_BAR_PAGES = ['/aurora-migration'];

export function RootBottomBar({ boardConfigs }: { boardConfigs: BoardConfigData }) {
  const { boardDetails, angle, hasActiveQueue } = useQueueBridgeBoardInfo();
  const pathname = usePathnameWithoutLocale();
  const isNative = isNativeApp();

  // /development is a hardware test rig for ESP32 emulators — it needs the full
  // viewport for the BLE payload inspector and has no use for either bar.
  const isDevelopmentRoute = pathname.startsWith('/development');
  const hideTabBar =
    isDevelopmentRoute || (HIDE_TAB_BAR_PAGES.some((prefix) => pathname.startsWith(prefix)) && !hasActiveQueue);
  const shouldShowQueueShell = !isDevelopmentRoute && isBoardRoutePath(pathname) && !hasActiveQueue && !boardDetails;

  // Measure the bottom bar's visual occlusion and publish it into the
  // sidecar --bottom-bar-height-measured custom property. The visible
  // --bottom-bar-height is computed in CSS as
  //   max(--bottom-bar-height-default, --bottom-bar-height-measured)
  // so the reserved height never shrinks below the SSR default — CSS
  // handles the never-shrink guarantee. JS only needs to track its own
  // last-published measurement (read back via the inline-style override,
  // which IS resolvable via parseFloat because it only ever contains
  // `${px}px`; reading the composed --bottom-bar-height via
  // getComputedStyle would return an unresolved calc()/max() string for
  // unregistered custom properties).
  //
  // Use viewportHeight - rect.top (not rect.height) so the iOS
  // `bottom: 2dvh` offset and the BottomNavigation's negative-margin
  // extension are both included. Prefer visualViewport.height over
  // innerHeight so iOS keyboard / URL-bar collapse shrinks the measured
  // value as expected (CSS max() with the default still floors it).
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  useIsomorphicLayoutEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const update = () => {
      const top = el.getBoundingClientRect().top;
      const viewportH = window.visualViewport?.height ?? window.innerHeight;
      const px = Math.max(0, viewportH - top);

      // Track the largest occlusion we've observed and publish it into
      // --bottom-bar-height-measured. CSS max(--default, --measured)
      // ensures the reserved space never shrinks below the default — the
      // dominant CLS source pre-fix. A 2px tolerance avoids ResizeObserver
      // jitter that doesn't change visible layout.
      const measuredRaw = document.documentElement.style.getPropertyValue('--bottom-bar-height-measured');
      const measuredPx = Number.parseFloat(measuredRaw) || 0;
      if (px > measuredPx + 2) {
        document.documentElement.style.setProperty('--bottom-bar-height-measured', `${px}px`);
      }
    };
    update();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
      document.documentElement.style.removeProperty('--bottom-bar-height-measured');
    };
  }, []);

  return (
    <div
      ref={wrapperRef}
      className={`${bottomBarStyles.bottomBarWrapper} ${isNative ? bottomBarStyles.nativeApp : ''}`}
      data-testid="bottom-bar-wrapper"
    >
      <FeedbackPromptBanner />
      {!isDevelopmentRoute && hasActiveQueue && boardDetails && (
        <ErrorBoundary>
          <BoardProvider boardName={boardDetails.board_name}>
            <ConnectionSettingsProvider>
              <WebSocketConnectionProvider>
                {/* BLE is provided once at the root (RootBluetoothProvider), an
                    ancestor of this bar — no per-bar provider needed. */}
                <RootQueueControlBarWithProviders boardDetails={boardDetails} angle={angle} />
              </WebSocketConnectionProvider>
            </ConnectionSettingsProvider>
          </BoardProvider>
        </ErrorBoundary>
      )}
      {shouldShowQueueShell && <QueueControlBarShell />}
      {!hideTabBar && <BottomTabBar boardDetails={boardDetails} angle={angle} boardConfigs={boardConfigs} />}
    </div>
  );
}

/**
 * Wraps QueueControlBar with FavoritesProvider and PlaylistsProvider.
 * Must be rendered inside QueueContext.Provider (via QueueBridge) so the
 * fine-grained hooks below (`useCurrentClimb`, `useQueueList`) resolve.
 * React Query deduplicates API calls with the board route's providers.
 */
function RootQueueControlBarWithProviders({
  boardDetails,
  angle,
}: {
  boardDetails: NonNullable<ReturnType<typeof useQueueBridgeBoardInfo>['boardDetails']>;
  angle: number;
}) {
  const { currentClimb } = useCurrentClimb();
  const { queue } = useQueueList();
  const { getLogbook } = useBoardProvider();

  const climbUuids = useMemo(() => {
    const queueUuids = queue.map((item) => item.climb?.uuid).filter(Boolean);
    if (currentClimb?.uuid) {
      queueUuids.push(currentClimb.uuid);
    }
    return Array.from(new Set(queueUuids)).sort();
  }, [queue, currentClimb]);

  // Ensure the play view drawer's "Your Logbook" section has data on
  // non-board routes (e.g. /you, /profile) where useQueueDataFetching
  // never mounts. React Query dedupes by key, so this is a no-op when
  // the board route already requested the same UUIDs.
  const climbUuidsKey = useMemo(() => climbUuids.join(','), [climbUuids]);
  useEffect(() => {
    if (climbUuids.length > 0) {
      void getLogbook(climbUuids);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- climbUuidsKey covers climbUuids identity changes
  }, [climbUuidsKey, getLogbook]);

  const { favoritesProviderProps, playlistsProviderProps } = useClimbActionsData({
    boardName: boardDetails.board_name,
    layoutId: boardDetails.layout_id,
    angle,
    climbUuids,
  });

  return (
    <FavoritesProvider {...favoritesProviderProps}>
      <PlaylistsProvider {...playlistsProviderProps}>
        <QueueControlBar boardDetails={boardDetails} angle={angle} />
      </PlaylistsProvider>
    </FavoritesProvider>
  );
}
