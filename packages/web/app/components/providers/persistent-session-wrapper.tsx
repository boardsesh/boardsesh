'use client';

import React, { useMemo } from 'react';
import { usePathname } from 'next/navigation';
import { PartyProfileProvider } from '../party-manager/party-profile-context';
import { PersistentSessionProvider, usePersistentSession } from '../persistent-session';
import { QueueBridgeProvider, useQueueBridgeBoardInfo } from '../queue-control/queue-bridge-context';
import { useQueueContext } from '../graphql-queue';
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
import { BoardConfigData } from '@/app/lib/server-board-configs';
import { isBoardRoutePath } from '@/app/lib/board-route-paths';
import GlobalHeader from '../global-header/global-header';
import SessionSummaryDialog from '../session-summary/session-summary-dialog';
import { SearchDrawerBridgeProvider } from '../search-drawer/search-drawer-bridge-context';

interface PersistentSessionWrapperProps {
  children: React.ReactNode;
  boardConfigs: BoardConfigData;
}

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
          <SearchDrawerBridgeProvider>
            <GlobalHeader boardConfigs={boardConfigs} />
            {children}
            <RootBottomBar boardConfigs={boardConfigs} />
            <RootSessionSummaryDialog />
          </SearchDrawerBridgeProvider>
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
  const { sessionSummary, dismissSessionSummary } = usePersistentSession();
  return <SessionSummaryDialog summary={sessionSummary} onDismiss={dismissSessionSummary} />;
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

  const hideTabBar = HIDE_TAB_BAR_PAGES.some((prefix) => pathname.startsWith(prefix)) && !hasActiveQueue;
  const shouldShowQueueShell = isBoardRoutePath(pathname) && !hasActiveQueue && !boardDetails;

  return (
    <div className={bottomBarStyles.bottomBarWrapper} data-testid="bottom-bar-wrapper">
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
      {!hideTabBar && <BottomTabBar boardConfigs={boardConfigs} />}
    </div>
  );
}

/**
 * Wraps QueueControlBar with FavoritesProvider and PlaylistsProvider.
 * Must be rendered inside QueueContext.Provider (via QueueBridge) so useQueueContext works.
 * React Query deduplicates API calls with the board route's providers.
 */
function RootQueueControlBarWithProviders({
  boardDetails,
  angle,
}: {
  boardDetails: NonNullable<ReturnType<typeof useQueueBridgeBoardInfo>['boardDetails']>;
  angle: number;
}) {
  const { queue, currentClimb } = useQueueContext();

  const climbUuids = useMemo(() => {
    const queueUuids = queue.map((item) => item.climb?.uuid).filter(Boolean) as string[];
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
