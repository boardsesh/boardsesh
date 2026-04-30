'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { usePathname } from 'next/navigation';
import { PartyProfileProvider } from '../party-manager/party-profile-context';
import { PersistentSessionProvider, usePersistentSession } from '../persistent-session';
import { QueueBridgeProvider, useQueueBridgeBoardInfo } from '../queue-control/queue-bridge-context';
import { useCurrentClimb, useQueueList } from '../graphql-queue';
import QueueControlBar from '../queue-control/queue-control-bar';
import QueueControlBarShell from '../queue-control/queue-control-bar-shell';
import BottomTabBar from '../bottom-tab-bar/bottom-tab-bar';
import { BoardProvider } from '../board-provider/board-provider-context';
import { ConnectionSettingsProvider } from '../connection-manager/connection-settings-context';
import { WebSocketConnectionProvider } from '../connection-manager/websocket-connection-provider';
import { BluetoothProvider } from '../board-bluetooth-control/bluetooth-context';
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
                  <GlobalHeader boardConfigs={boardConfigs} />
                  {children}
                  <RootBottomBar boardConfigs={boardConfigs} />
                  <RootSessionSummaryDialog />
                  <RootSeshSettingsDrawer />
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
 * Root-level session summary dialog.
 * Consumes sessionSummary/dismissSessionSummary from PersistentSessionContext
 * so session ending works from any page (not just board routes).
 */
function RootSessionSummaryDialog() {
  const { sessionSummary, sessionSummaryBoardType, sessionSummaryHealthKitWorkoutId, dismissSessionSummary } =
    usePersistentSession();
  return (
    <SessionSummaryDialog
      summary={sessionSummary}
      boardType={sessionSummaryBoardType ?? ''}
      existingWorkoutId={sessionSummaryHealthKitWorkoutId}
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
  const pathname = usePathname();
  const isNative = isNativeApp();

  const hideTabBar = HIDE_TAB_BAR_PAGES.some((prefix) => pathname.startsWith(prefix)) && !hasActiveQueue;
  const shouldShowQueueShell = isBoardRoutePath(pathname) && !hasActiveQueue && !boardDetails;

  return (
    <div
      className={`${bottomBarStyles.bottomBarWrapper} ${isNative ? bottomBarStyles.nativeApp : ''}`}
      data-testid="bottom-bar-wrapper"
    >
      <FeedbackPromptBanner />
      {hasActiveQueue && boardDetails && (
        <ErrorBoundary>
          <BoardProvider boardName={boardDetails.board_name}>
            <ConnectionSettingsProvider>
              <WebSocketConnectionProvider>
                <BluetoothProvider boardDetails={boardDetails}>
                  <RootQueueControlBarWithProviders boardDetails={boardDetails} angle={angle} />
                </BluetoothProvider>
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
 * Must be rendered inside QueueContext.Provider (via QueueBridge) so useQueueData works.
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

  const climbUuids = useMemo(() => {
    const queueUuids = queue.map((item) => item.climb?.uuid).filter(Boolean);
    if (currentClimb?.uuid) {
      queueUuids.push(currentClimb.uuid);
    }
    return Array.from(new Set(queueUuids)).sort();
  }, [queue, currentClimb]);

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
