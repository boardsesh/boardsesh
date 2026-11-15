import { LayoutObserverProvider } from '../../lib/showcase-anchor';
import { reportLayoutObservation } from './layout-reporting';
export { appearance, initialLocale } from './config';
export { IntegrationBoardSetup } from './IntegrationBoardSetup';
import { IntegrationVideoController } from './IntegrationVideoController';
import { IntegrationNavigationObserver } from './IntegrationNavigationObserver';
import { useEffect, useRef, type ReactNode } from 'react';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { ConsentSettledContext } from '../../lib/consent-hooks';
import { ContentRenderObserverProvider, type ContentRenderObservation } from '../../components/ContentRenderObserver';
import { reportScreenshotSmokeContent, reportScreenshotSmokeError } from './screenshot-smoke';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { INFINITE_SEARCH_CLIMBS_QUERY_KEY } from '../../lib/graphql/query-keys';
import type { SearchClimbsQueryResponse } from '../../lib/graphql/operations';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { toQueueClimb } from '../../lib/climb-types';
import { selectSmokeClimb } from './select-smoke-climb';

function observeContent({ route, count }: ContentRenderObservation): void {
  if (route === '/home' || route === '/profile' || route === '/climbs' || route === 'play-drawer') {
    reportScreenshotSmokeContent(route, count);
  }
}

export function IntegrationSmokeBoundary({ children }: { children: ReactNode }) {
  return (
    <LayoutObserverProvider onLayoutObserved={reportLayoutObservation}>
      <ContentRenderObserverProvider onContentRendered={observeContent}>
        <IntegrationNavigationObserver />
        {process.env.EXPO_PUBLIC_RECORDING_MODE === '1' ? <IntegrationVideoController /> : null}
        {children}
      </ContentRenderObserverProvider>
    </LayoutObserverProvider>
  );
}

/** Mounted by the root error boundary, including failures that unmount all providers. */
export function IntegrationSmokeError({ error }: { error: Error }) {
  useEffect(() => {
    reportScreenshotSmokeError(error);
  }, [error]);
  return null;
}

/** Test navigation uses already-loaded real queries and the real drawer action. */
export function OpenFirstSmokeClimb() {
  const queryClient = useQueryClient();
  const { data: board } = useActiveBoard();
  const { openPlayDrawer } = useDrawerHost();
  const opened = useRef(false);

  useEffect(() => {
    if (!board || opened.current) return;
    const cache = queryClient.getQueryCache();
    const openLoadedClimb = () => {
      if (opened.current) return;
      const queries = cache.findAll({ queryKey: INFINITE_SEARCH_CLIMBS_QUERY_KEY, type: 'active' });
      const searches = queries.flatMap((query) => {
        if (query.state.status !== 'success' || query.state.fetchStatus !== 'idle') return [];
        const result = query.state.data as InfiniteData<SearchClimbsQueryResponse> | undefined;
        return result ? [{ input: query.queryKey[1], pages: result.pages, updatedAt: query.state.dataUpdatedAt }] : [];
      });
      const climb = selectSmokeClimb(searches, board);
      if (!climb) return;
      opened.current = true;
      openPlayDrawer(toQueueClimb(climb), {
        boardConfig: {
          boardName: board.boardType,
          layoutId: board.layoutId,
          sizeId: board.sizeId,
          setIds: board.setIds,
          angle: board.angle,
        },
      });
    };
    const unsubscribe = cache.subscribe(openLoadedClimb);
    const timeout = setTimeout(() => {
      if (!opened.current) reportScreenshotSmokeError(new Error('No loaded climb for the active board'));
    }, 60_000);
    openLoadedClimb();
    return () => {
      unsubscribe();
      clearTimeout(timeout);
    };
  }, [board, openPlayDrawer, queryClient]);

  return <Stack.Screen options={{ headerShown: false }} />;
}

/** Consent/network synchronization is outside this navigation smoke's assertions. */
export function IntegrationConsentBoundary({ children }: { children: ReactNode }) {
  return <ConsentSettledContext value={true}>{children}</ConsentSettledContext>;
}
