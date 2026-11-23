'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as Sentry from '@sentry/nextjs';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import type { SprayWallDirectoryEntry } from '@boardsesh/graphql/operations';
import type { DirectoryQuery } from '@/app/gyms/directory-facets';
import GymPlaceSearch from '@/app/gyms/gym-place-search';
import GymDirectoryMap from '@/app/gyms/gym-directory-map';
import {
  NEAR_ME_RADIUS_OPTIONS_KM,
  NEAR_ME_RESULT_LIMIT,
  nearMeFallbackReason,
  roundCoordinate,
} from '@/app/gyms/near-me-model';
import LocaleLink from '@/app/components/i18n/locale-link';
import { useGeolocation } from '@/app/hooks/use-geolocation';
import type { Locale } from '@/app/lib/i18n/config';
import {
  buildSprayDirectoryHref,
  SPRAY_DIRECTORY_PATH,
  sprayDirectoryInput,
  sprayDirectoryPins,
} from './directory-model';
import { requestSprayDirectory } from './directory-request';
import SprayDirectoryRows from './spray-directory-rows';

const WIDE_LAYOUT = '@media (min-width: 960px)';
const NO_WALLS: SprayWallDirectoryEntry[] = [];

export default function SprayDirectoryExplorer({
  query,
  locale,
  walls,
  filters,
  children,
}: {
  query: DirectoryQuery;
  locale: Locale;
  walls: SprayWallDirectoryEntry[];
  filters: React.ReactNode;
  children: React.ReactNode;
}) {
  const { t } = useTranslation('website');
  const { t: gyms } = useTranslation('gyms');
  const location = useGeolocation();
  const [nearMe, setNearMe] = useState(false);
  const [radiusKm, setRadiusKm] = useState(25);
  const [mapOpen, setMapOpen] = useState(false);
  const mapContainer = useRef<HTMLDivElement>(null);
  const revealMap = useRef(false);
  const [geolocationSupported, setGeolocationSupported] = useState(true);
  useEffect(() => {
    setGeolocationSupported(typeof navigator !== 'undefined' && 'geolocation' in navigator);
    const restoreMap = () => {
      revealMap.current = false;
      setMapOpen(new URLSearchParams(window.location.search).get('view') === 'map');
    };
    restoreMap();
    window.addEventListener('popstate', restoreMap);
    return () => window.removeEventListener('popstate', restoreMap);
  }, []);
  useEffect(() => {
    if (!revealMap.current) return;
    revealMap.current = false;
    mapContainer.current?.scrollIntoView({ block: 'start', behavior: 'auto' });
  }, [mapOpen]);

  const latitude = location.coordinates ? roundCoordinate(location.coordinates.latitude) : null;
  const longitude = location.coordinates ? roundCoordinate(location.coordinates.longitude) : null;
  const nearMeActive = nearMe && latitude !== null && longitude !== null;
  const fallbackReason = nearMeFallbackReason({ geolocationSupported, error: location.error });
  const nearQuery = { ...query, latitude, longitude, radiusKm, page: 1 };
  const nearbyInput = sprayDirectoryInput(nearQuery, NEAR_ME_RESULT_LIMIT);
  const nearby = useQuery({
    queryKey: ['public-spray-wall-directory', nearbyInput],
    enabled: nearMeActive,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    queryFn: async ({ signal }) => {
      try {
        return await requestSprayDirectory(nearbyInput, signal);
      } catch (error) {
        if (!signal.aborted)
          Sentry.captureException(error, { tags: { surface: 'spray-wall-directory', operation: 'nearby' } });
        throw error;
      }
    },
  });

  const shownWalls = nearMeActive
    ? nearby.isError || nearby.isFetching
      ? NO_WALLS
      : (nearby.data?.boards ?? NO_WALLS)
    : walls;
  const pins = useMemo(() => sprayDirectoryPins(shownWalls), [shownWalls]);
  const clusterLabel = useCallback((count: number) => t('sprayDirectory.results', { count }), [t]);
  const mapLabels = useMemo(
    () => ({
      region: t('sprayDirectory.mapRegion'),
      coverage: t('sprayDirectory.mapPinned', {
        count: shownWalls.length,
        pinned: pins.length,
        total: shownWalls.length,
      }),
      cluster: clusterLabel,
    }),
    [t, shownWalls.length, pins.length, clusterLabel],
  );
  const selectedArea = query.latitude !== null && query.longitude !== null;

  const toggleMap = () => {
    const nextOpen = !mapOpen;
    revealMap.current = nextOpen;
    setMapOpen(nextOpen);
    const nextUrl = new URL(window.location.href);
    if (nextOpen) nextUrl.searchParams.set('view', 'map');
    else nextUrl.searchParams.delete('view');
    window.history.replaceState(window.history.state, '', nextUrl);
  };

  return (
    <>
      <GymPlaceSearch
        query={query}
        locale={locale}
        directory={{
          basePath: SPRAY_DIRECTORY_PATH,
          selectedPlaceBaseHref: buildSprayDirectoryHref(query),
          inputId: 'spray-directory-query',
          placeRadiusKm: 25,
          searchLabel: t('sprayDirectory.searchLabel'),
          searchPlaceholder: t('sprayDirectory.searchPlaceholder'),
          searchSubmit: t('sprayDirectory.searchSubmit'),
          placeHint: t('sprayDirectory.placesHint'),
          placeEmpty: t('sprayDirectory.placesEmpty'),
          placeError: t('sprayDirectory.placesError'),
        }}
        actions={
          <>
            <Button
              type="button"
              variant="outlined"
              aria-pressed={nearMe}
              sx={{ minHeight: 44 }}
              onClick={() => {
                setNearMe(!nearMe);
                if (!nearMe) void location.requestPermission();
              }}
            >
              {nearMe ? t('sprayDirectory.allWalls') : t('sprayDirectory.nearMe')}
            </Button>
            <Button
              type="button"
              variant="outlined"
              onClick={toggleMap}
              aria-expanded={mapOpen}
              aria-controls="spray-directory-map"
              sx={{ minHeight: 44, [WIDE_LAYOUT]: { display: 'none' } }}
            >
              {mapOpen ? gyms('map.hideMap') : gyms('map.showMap')}
            </Button>
          </>
        }
      >
        {filters}
      </GymPlaceSearch>

      {nearMe && location.loading && <CircularProgress size={24} aria-label={gyms('nearMe.locating')} />}
      {nearMe && fallbackReason && (
        <Alert severity="info" sx={{ mb: 2 }}>
          {fallbackReason === 'denied'
            ? gyms('nearMe.deniedBody')
            : fallbackReason === 'unsupported'
              ? gyms('nearMe.unsupportedBody')
              : gyms('nearMe.unavailableBody')}
        </Alert>
      )}
      {(nearMeActive || selectedArea) && (
        <Box sx={{ mb: 3 }}>
          {selectedArea && !nearMeActive && (
            <Typography variant="body1">
              {t('sprayDirectory.selectedArea', {
                radius: query.radiusKm,
                place: query.place ?? gyms('places.selectedArea'),
              })}
            </Typography>
          )}
          <Typography variant="body2" sx={{ mb: 1 }}>
            {t('sprayDirectory.pinlessNotice')}
          </Typography>
          <Box role="group" aria-label={gyms('nearMe.radiusLabel')} sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {NEAR_ME_RADIUS_OPTIONS_KM.map((radius) =>
              nearMeActive ? (
                <Button
                  key={radius}
                  type="button"
                  variant={radiusKm === radius ? 'contained' : 'outlined'}
                  aria-pressed={radiusKm === radius}
                  onClick={() => setRadiusKm(radius)}
                  sx={{ minHeight: 44 }}
                >
                  {gyms(`nearMe.radius.${radius}`)}
                </Button>
              ) : (
                <Button
                  key={radius}
                  component={LocaleLink}
                  href={buildSprayDirectoryHref({ ...query, radiusKm: radius })}
                  variant={query.radiusKm === radius ? 'contained' : 'outlined'}
                  sx={{ minHeight: 44 }}
                >
                  {gyms(`nearMe.radius.${radius}`)}
                </Button>
              ),
            )}
          </Box>
        </Box>
      )}

      {nearMeActive && (
        <Box aria-live="polite" sx={{ mb: 2 }}>
          {nearby.isFetching ? (
            <CircularProgress size={24} aria-label={t('sprayDirectory.nearbyTitle')} />
          ) : nearby.isError ? (
            <Alert
              severity="warning"
              action={<Button onClick={() => void nearby.refetch()}>{t('sprayDirectory.retry')}</Button>}
            >
              {t('sprayDirectory.errorBody')}
            </Alert>
          ) : nearby.data?.boards.length === 0 ? (
            <Typography>{t('sprayDirectory.nearbyEmpty')}</Typography>
          ) : null}
        </Box>
      )}
      <Box
        sx={{
          display: 'grid',
          gap: 3,
          alignItems: 'start',
          [WIDE_LAYOUT]: { gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)' },
        }}
      >
        <Box
          id="spray-directory-results"
          sx={{ minWidth: 0, display: mapOpen ? 'none' : 'block', [WIDE_LAYOUT]: { display: 'block' } }}
          aria-live="polite"
        >
          {nearMeActive ? (
            !nearby.isFetching && !nearby.isError && nearby.data ? (
              <>
                <Typography component="h2" variant="h6" sx={{ mb: 2 }}>
                  {t('sprayDirectory.nearbyCount', { count: nearby.data.totalCount, radius: radiusKm })}
                </Typography>
                {nearby.data.hasMore && (
                  <Typography variant="body2">
                    {t('sprayDirectory.nearbyCapped', {
                      shown: nearby.data.boards.length,
                      total: nearby.data.totalCount,
                    })}
                  </Typography>
                )}
                <SprayDirectoryRows walls={nearby.data.boards} locale={locale} />
              </>
            ) : null
          ) : (
            children
          )}
        </Box>
        <Box
          id="spray-directory-map"
          ref={mapContainer}
          sx={{
            minWidth: 0,
            display: mapOpen ? 'block' : 'none',
            scrollMarginTop: 'calc(var(--global-header-height) + var(--spacing-4))',
            [WIDE_LAYOUT]: {
              display: 'block',
              position: 'sticky',
              top: 'calc(var(--global-header-height) + var(--spacing-4))',
            },
          }}
        >
          <GymDirectoryMap
            pins={pins}
            pinnedCount={pins.length}
            shownCount={shownWalls.length}
            locale={locale}
            labels={mapLabels}
          />
        </Box>
      </Box>
    </>
  );
}
