'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import { useSpaRouter, type SpaRoute } from './hooks/use-spa-router';
import { useSpaBoard } from './hooks/use-spa-board';
import { SpaClimbListScreen } from './spa-climb-list-screen';
import { SpaClimbViewScreen } from './spa-climb-view-screen';
import { constructBoardSlugListUrl } from '@/app/lib/url-utils';

type BoardRoute = Extract<SpaRoute, { screen: 'list' | 'view' }>;

function SpaBoardScreen({
  route,
  searchParams,
  navigate,
}: {
  route: BoardRoute;
  searchParams: URLSearchParams;
  navigate: (path: string, options?: { replace?: boolean }) => void;
}) {
  const { t } = useTranslation('climbs');
  const { data: spaBoard, isLoading } = useSpaBoard(route.boardSlug, route.angle);

  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!spaBoard) {
    return (
      <Box sx={{ p: 4 }}>
        <Typography>{t('spa.routeNotFound')}</Typography>
      </Box>
    );
  }

  if (route.screen === 'view') {
    return (
      <SpaClimbViewScreen
        spaBoard={spaBoard}
        climbUuid={route.climbUuid}
        onBackToList={() => navigate(`/spa${constructBoardSlugListUrl(route.boardSlug, route.angle)}`)}
      />
    );
  }

  return (
    <SpaClimbListScreen
      boardSlug={route.boardSlug}
      angle={route.angle}
      spaBoard={spaBoard}
      searchParams={searchParams}
      navigate={navigate}
    />
  );
}

/** Root of the pure client-side-routed SPA experiment. Navigation is driven
 * entirely by `window.navigation` (see hooks/use-spa-router.ts) — Next's
 * router is never invoked past the initial document load of app/spa/[[...path]]. */
export default function SpaApp() {
  const { t } = useTranslation('climbs');
  const router = useSpaRouter();

  if (!router.isNavigationApiSupported) {
    return (
      <Box sx={{ p: 4 }}>
        <Typography>{t('spa.unsupportedBrowser')}</Typography>
      </Box>
    );
  }

  if (router.route.screen === 'not-found') {
    return (
      <Box sx={{ p: 4 }}>
        <Typography>{t('spa.routeNotFound')}</Typography>
      </Box>
    );
  }

  return <SpaBoardScreen route={router.route} searchParams={router.searchParams} navigate={router.navigate} />;
}
