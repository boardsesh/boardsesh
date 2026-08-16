'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import MapOutlined from '@mui/icons-material/MapOutlined';
import MyLocationOutlined from '@mui/icons-material/MyLocationOutlined';
import {
  SEARCH_GYMS_DIRECTORY,
  type SearchGymsDirectoryQueryResponse,
  type SearchGymsDirectoryQueryVariables,
} from '@boardsesh/graphql/operations';
import type { GymClaimViewerState } from '@boardsesh/analytics';
import { useGeolocation } from '@/app/hooks/use-geolocation';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import type { Locale } from '@/app/lib/i18n/config';
import { themeTokens } from '@/app/theme/theme-config';
import GymDirectoryCard from './gym-directory-card';
import GymDirectoryMap from './gym-directory-map';
import GymDirectorySearchTracker from './gym-directory-search-tracker';
import {
  DEFAULT_NEAR_ME_RADIUS_KM,
  NEAR_ME_RADIUS_OPTIONS_KM,
  NEAR_ME_RESULT_LIMIT,
  nearMeFallbackReason,
  pinCoverage,
  roundCoordinate,
  toMapPins,
  type MapPin,
  type NearMeRadiusKm,
} from './near-me-model';

/**
 * The breakpoint from the #4372 wireframe, in one place.
 *
 * A media-query string, deliberately — no `matchMedia`, no `useMediaQuery`, no
 * `window.innerWidth`. A JS breakpoint read renders the wrong layout on the
 * server, hydrates into a flash, and gets the answer wrong entirely in a
 * container query or a resized window until something re-renders.
 */
const WIDE_LAYOUT = '@media (min-width: 960px)';

type GymDirectoryNearMeProps = {
  /** Board types the surrounding route is already filtered to. */
  boardTypes: string[];
  locale: Locale;
  viewerState: GymClaimViewerState;
  /** Pins for the server-rendered page, so browse mode has a populated map. */
  browsePins: MapPin[];
  browsePinnedCount: number;
  browseShownCount: number;
  /** The server-rendered results block: heading, card grid, pagination. */
  children: React.ReactNode;
};

/**
 * The map column and the opt-in "near me" mode around #4512's results list.
 *
 * Two rules shape everything below.
 *
 * **The list is the page.** Browse mode — what every crawler and first-time
 * visitor gets — renders the server's list untouched, with the map as a
 * secondary column beside it. Near-me is a thing somebody chooses.
 *
 * **Near-me hides gyms, so it says so.** Both proximity paths in `searchGyms`
 * hard-filter `location IS NOT NULL`, and only ~63% of gyms have a pin (DB-06),
 * so switching to near-me silently drops more than a third of the catalog. It
 * is opt-in, it carries the notice, and one tap puts the full list back.
 *
 * **No `?lat`/`?lng`/`?radius`.** Coordinates in the URL are sent to OSM's tile
 * servers in the `Referer` header of every tile request the page makes. The
 * cost is that near-me state is not shareable or restorable with Back; that
 * trade is deliberate.
 */
export default function GymDirectoryNearMe({
  boardTypes,
  locale,
  viewerState,
  browsePins,
  browsePinnedCount,
  browseShownCount,
  children,
}: GymDirectoryNearMeProps) {
  const { t } = useTranslation('gyms');

  // Called with NO argument. `useGeolocation(options)` lists `options` in a
  // `useCallback` dependency array, so an inline object literal rebuilds the
  // position getter — and every callback derived from it — on every render.
  const { coordinates, error, loading, requestPermission } = useGeolocation();

  const [nearMeOn, setNearMeOn] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [radiusKm, setRadiusKm] = useState<NearMeRadiusKm>(DEFAULT_NEAR_ME_RADIUS_KM);
  // Resolved in an effect rather than at render: `navigator` does not exist
  // during SSR, and a render-time read would make the server and the first
  // client render disagree.
  const [geolocationSupported, setGeolocationSupported] = useState(true);

  useEffect(() => {
    setGeolocationSupported(typeof navigator !== 'undefined' && 'geolocation' in navigator);
  }, []);

  const fallbackReason = nearMeFallbackReason({ geolocationSupported, error });

  const latitude = coordinates ? roundCoordinate(coordinates.latitude) : null;
  const longitude = coordinates ? roundCoordinate(coordinates.longitude) : null;
  const nearMeActive = nearMeOn && latitude !== null && longitude !== null;

  const boardTypesKey = useMemo(() => [...boardTypes].sort().join(','), [boardTypes]);

  const nearMeQuery = useQuery({
    // Rounded coordinates only, and only as a cache key — they never reach an
    // analytics payload, a URL, or a tile request.
    queryKey: ['gym-directory-near-me', boardTypesKey, latitude, longitude, radiusKm],
    queryFn: async () => {
      if (latitude === null || longitude === null) {
        // Unreachable: `enabled` gates on the same two values.
        throw new Error('near-me query ran without an origin');
      }
      const client = createGraphQLHttpClient();
      const response = await client.request<SearchGymsDirectoryQueryResponse, SearchGymsDirectoryQueryVariables>(
        SEARCH_GYMS_DIRECTORY,
        {
          input: {
            ...(boardTypes.length > 0 ? { boardTypes } : {}),
            latitude,
            longitude,
            radiusKm,
            requireSlug: true,
            // Capped at what the backend's zod accepts. It throws on more; it
            // does not clamp.
            limit: NEAR_ME_RESULT_LIMIT,
            offset: 0,
          },
        },
      );
      return response.searchGyms;
    },
    enabled: nearMeActive,
    staleTime: 5 * 60 * 1000,
  });

  const nearMeGyms = useMemo(
    () => (nearMeActive ? (nearMeQuery.data?.gyms ?? []) : []),
    [nearMeActive, nearMeQuery.data],
  );
  const nearMePins = useMemo(() => toMapPins(nearMeGyms), [nearMeGyms]);
  const nearMeCoverage = useMemo(() => pinCoverage(nearMeGyms), [nearMeGyms]);

  const showingNearMeResults = nearMeActive && nearMeQuery.data !== undefined;
  const pins = showingNearMeResults ? nearMePins : browsePins;
  const pinnedCount = showingNearMeResults ? nearMeCoverage.pinned : browsePinnedCount;
  const shownCount = showingNearMeResults ? nearMeCoverage.total : browseShownCount;

  const origin = nearMeActive && latitude !== null && longitude !== null ? { latitude, longitude } : null;

  const handleUseMyLocation = useCallback(() => {
    setNearMeOn(true);
    if (!coordinates) {
      void requestPermission();
    }
  }, [coordinates, requestPermission]);

  const handleShowAll = useCallback(() => {
    setNearMeOn(false);
  }, []);

  const handleRadiusChange = useCallback((_event: React.MouseEvent<HTMLElement>, next: NearMeRadiusKm | null) => {
    if (next !== null) {
      setRadiusKm(next);
    }
  }, []);

  return (
    <>
      {/* Reuses #4512's tracker: a near-me search IS a search application, and
          it fires once per RESULT SET rather than per interaction, so panning,
          toggling the map and re-picking a radius that returns the same count
          are not events. `hasGeo` is a boolean; no coordinate goes with it. */}
      {showingNearMeResults && (
        <GymDirectorySearchTracker
          queryLength={0}
          boardTypesKey={boardTypesKey}
          hasGeo
          resultsCount={nearMeQuery.data.totalCount}
        />
      )}

      <Box component="section" sx={{ mb: 3 }}>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, alignItems: 'center' }}>
          {/* Keyed on ACTIVE, not on "the button was pressed": after a denial
              the control has to offer the retry again, not a "show all" for a
              near-me list that never rendered. */}
          {nearMeActive ? (
            <Button variant="outlined" onClick={handleShowAll} sx={{ textTransform: 'none' }}>
              {t('nearMe.showAll')}
            </Button>
          ) : (
            <Button
              variant="contained"
              startIcon={<MyLocationOutlined />}
              onClick={handleUseMyLocation}
              disabled={loading || fallbackReason === 'unsupported'}
              sx={{ textTransform: 'none' }}
            >
              {loading ? t('nearMe.locating') : t('nearMe.cta')}
            </Button>
          )}

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography variant="body2" color="text.secondary" id="gym-near-me-radius-label">
              {t('nearMe.radiusLabel')}
            </Typography>
            <ToggleButtonGroup
              exclusive
              size="small"
              value={radiusKm}
              onChange={handleRadiusChange}
              aria-labelledby="gym-near-me-radius-label"
            >
              {NEAR_ME_RADIUS_OPTIONS_KM.map((option) => (
                <ToggleButton key={option} value={option} sx={{ textTransform: 'none' }}>
                  {radiusOptionLabel(t, option)}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          </Box>
        </Box>

        {/* `unsupported` shows unprompted: the button is disabled on a browser
            with no geolocation API, so waiting for a press would mean the hint
            never appears on the one browser that only has the text fallback. */}
        {fallbackReason !== null && (nearMeOn || fallbackReason === 'unsupported') && (
          <Alert severity="info" sx={{ mt: 1.5, borderRadius: `${themeTokens.borderRadius.lg}px` }}>
            {fallbackBody(t, fallbackReason)}
          </Alert>
        )}

        {nearMeActive && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5, maxWidth: '68ch' }}>
            {t('nearMe.pinlessNotice')}
          </Typography>
        )}
      </Box>

      <Box
        sx={{
          display: 'grid',
          gap: 3,
          gridTemplateColumns: 'minmax(0, 1fr)',
          [WIDE_LAYOUT]: { gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 360px)', alignItems: 'start' },
        }}
      >
        {/* The list column is FIRST in the DOM at every width. The map is never
            in front of it and never replaces it. */}
        <Box>
          {nearMeActive ? (
            <NearMeResults
              gyms={nearMeGyms}
              isPending={nearMeQuery.isPending}
              isError={nearMeQuery.isError}
              origin={origin}
              radiusKm={radiusKm}
              locale={locale}
              viewerState={viewerState}
            />
          ) : (
            children
          )}
        </Box>

        <Box sx={{ [WIDE_LAYOUT]: { position: 'sticky', top: 'calc(var(--global-header-height) + 16px)' } }}>
          <Button
            variant="outlined"
            startIcon={<MapOutlined />}
            onClick={() => setMapOpen((open) => !open)}
            sx={{ textTransform: 'none', mb: 1.5, [WIDE_LAYOUT]: { display: 'none' } }}
          >
            {mapOpen ? t('map.hideMap') : t('map.showMap')}
          </Button>
          {/* Hidden with `display: none`, which is what keeps the Leaflet
              bundle undownloaded below the breakpoint: the map's effect waits
              for its container to report a non-zero size. */}
          <Box sx={{ display: mapOpen ? 'block' : 'none', [WIDE_LAYOUT]: { display: 'block' } }}>
            <GymDirectoryMap pins={pins} pinnedCount={pinnedCount} shownCount={shownCount} locale={locale} />
          </Box>
        </Box>
      </Box>
    </>
  );
}

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

/**
 * Radius labels as LITERAL `t()` call sites.
 *
 * `t(\`nearMe.radius.${km}\`)` reads better and is a hard lint failure: the
 * orphan checker cannot follow a computed key, so those four strings would look
 * unused and get deleted from the catalogs by the next cleanup pass.
 */
function radiusOptionLabel(t: TranslateFn, km: NearMeRadiusKm): string {
  switch (km) {
    case 10:
      return t('nearMe.radius.10');
    case 25:
      return t('nearMe.radius.25');
    case 50:
      return t('nearMe.radius.50');
    case 100:
      return t('nearMe.radius.100');
  }
}

function fallbackBody(t: TranslateFn, reason: 'unsupported' | 'denied' | 'unavailable'): string {
  switch (reason) {
    case 'unsupported':
      return t('nearMe.unsupportedBody');
    case 'denied':
      return t('nearMe.deniedBody');
    case 'unavailable':
      return t('nearMe.unavailableBody');
  }
}

type NearMeResultsProps = {
  gyms: SearchGymsDirectoryQueryResponse['searchGyms']['gyms'];
  isPending: boolean;
  isError: boolean;
  origin: { latitude: number; longitude: number } | null;
  radiusKm: NearMeRadiusKm;
  locale: Locale;
  viewerState: GymClaimViewerState;
};

function NearMeResults({ gyms, isPending, isError, origin, radiusKm, locale, viewerState }: NearMeResultsProps) {
  const { t } = useTranslation('gyms');
  const formatNumber = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  if (isPending) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 4 }}>
        <CircularProgress size={20} />
        <Typography variant="body2" color="text.secondary">
          {t('nearMe.loading')}
        </Typography>
      </Box>
    );
  }

  if (isError) {
    return (
      <Alert severity="warning" sx={{ borderRadius: `${themeTokens.borderRadius.lg}px` }}>
        {t('nearMe.error')}
      </Alert>
    );
  }

  return (
    <>
      <Typography
        variant="subtitle1"
        component="h2"
        sx={{ fontWeight: themeTokens.typography.fontWeight.semibold, mb: 1.5 }}
      >
        {t('nearMe.resultsHeading', {
          count: gyms.length,
          formattedCount: formatNumber.format(gyms.length),
          radius: radiusKm,
        })}
      </Typography>

      {gyms.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
          {t('nearMe.empty')}
        </Typography>
      ) : (
        <Box
          component="ul"
          sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)' }, gap: 2, m: 0, p: 0 }}
        >
          {gyms.map((gym) => (
            <GymDirectoryCard key={gym.uuid} gym={gym} origin={origin} viewerState={viewerState} locale={locale} />
          ))}
        </Box>
      )}
    </>
  );
}
