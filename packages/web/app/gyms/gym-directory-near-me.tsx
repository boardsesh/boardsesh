'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { gymDirectorySearched, type GymClaimViewerState } from '@boardsesh/analytics';
import { useGeolocation } from '@/app/hooks/use-geolocation';
import { trackGymFunnelEvent } from '@/app/lib/gym-funnel-analytics';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import type { Locale } from '@/app/lib/i18n/config';
import { themeTokens } from '@/app/theme/theme-config';
import { numberFormatFor } from './directory-card-model';
import GymDirectoryCard from './gym-directory-card';
import GymDirectoryMap from './gym-directory-map';
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
  /** The visitor's `?q=` text, carried into the near-me query unchanged. */
  searchQuery: string;
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
 * Three rules shape everything below.
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
 * **Near-me applies every filter the page is showing.** The text search comes
 * through as `searchQuery`, because the search box keeps rendering what the
 * visitor typed: a near-me mode that quietly ignored it would leave the UI
 * asserting a filter that is not applied, and would report `queryLength: 0` for
 * a search that had one.
 *
 * **No `?lat`/`?lng`/`?radius`.** Not a `Referer` concern — `next.config.mjs`
 * already sends `Referrer-Policy: strict-origin-when-cross-origin`, so a tile
 * request carries the origin and never the query string. The reasons are that a
 * shareable URL should not carry somebody's precise location, and that
 * coordinate params would need their own canonical handling. #4380's AC and
 * #4512's server-side parsing both anticipate those params, so the door is open
 * if we ever want them; the cost of staying client-only is that near-me state
 * is not shareable and Back does not restore it.
 */
export default function GymDirectoryNearMe({
  boardTypes,
  searchQuery,
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
    queryKey: ['gym-directory-near-me', boardTypesKey, searchQuery, latitude, longitude, radiusKm],
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
            // Same shape the server builds in `toSearchGymsInput`, so near-me
            // is the browse query plus an origin — not a different search.
            ...(searchQuery ? { query: searchQuery } : {}),
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

  const nearMeData = nearMeQuery.data;
  // ONE flag for the list and the map. Splitting them meant that during every
  // fetch the list spun while the map still showed the browse page's pins under
  // a pill describing them — two surfaces answering different questions.
  const showingNearMeResults = nearMeActive && nearMeData !== undefined;

  const nearMeGyms = useMemo(() => (showingNearMeResults ? nearMeData.gyms : []), [showingNearMeResults, nearMeData]);
  const nearMePins = useMemo(() => toMapPins(nearMeGyms), [nearMeGyms]);
  const nearMeCoverage = useMemo(() => pinCoverage(nearMeGyms), [nearMeGyms]);

  const pins = showingNearMeResults ? nearMePins : browsePins;
  const pinnedCount = showingNearMeResults ? nearMeCoverage.pinned : browsePinnedCount;
  const shownCount = showingNearMeResults ? nearMeCoverage.total : browseShownCount;

  const origin = showingNearMeResults && latitude !== null && longitude !== null ? { latitude, longitude } : null;

  /**
   * `Gym Directory Searched`, once per DISTINCT near-me search.
   *
   * A ref-held set of signatures rather than a mounted tracker component,
   * because a tracker keyed off the query result re-fires on things that are
   * not new searches: changing the radius swaps the query key, so `data` goes
   * undefined, the tracker unmounts and remounts and fires again — and flipping
   * 25 -> 100 -> 25 replays cached data and fires a third time. A set, not a
   * "last value", is what catches that third one.
   */
  const reportedSearchesRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!showingNearMeResults) return;
    const signature = `${boardTypesKey}|${searchQuery.length}|${radiusKm}|${nearMeData.totalCount}`;
    if (reportedSearchesRef.current.has(signature)) return;
    reportedSearchesRef.current.add(signature);

    trackGymFunnelEvent(
      gymDirectorySearched({
        // The length only — the search text itself never leaves the browser,
        // and no coordinate goes with `hasGeo`.
        queryLength: searchQuery.length,
        boardTypes: boardTypesKey ? boardTypesKey.split(',') : [],
        hasGeo: true,
        resultsCount: nearMeData.totalCount,
      }),
    );
  }, [showingNearMeResults, nearMeData, boardTypesKey, searchQuery, radiusKm]);

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
      <Box component="section" sx={{ mb: 3 }}>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, alignItems: 'center' }}>
          {/* Keyed on the RESULTS being on screen, not on "the button was
              pressed": after a denial the control has to offer the retry again,
              not a "show all" for a near-me list that never rendered. */}
          {showingNearMeResults ? (
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

          {/* The list keeps showing the full catalog until the near-me results
              land, so the in-flight feedback belongs here, next to the control
              that started it. */}
          {nearMeActive && nearMeQuery.isPending && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <CircularProgress size={16} />
              <Typography variant="body2" color="text.secondary">
                {t('nearMe.loading')}
              </Typography>
            </Box>
          )}
        </Box>

        {/* `unsupported` shows unprompted: the button is disabled on a browser
            with no geolocation API, so waiting for a press would mean the hint
            never appears on the one browser that only has the text fallback. */}
        {fallbackReason !== null && (nearMeOn || fallbackReason === 'unsupported') && (
          <Alert severity="info" sx={{ mt: 1.5, borderRadius: `${themeTokens.borderRadius.lg}px` }}>
            {fallbackBody(t, fallbackReason)}
          </Alert>
        )}

        {nearMeActive && nearMeQuery.isError && (
          <Alert severity="warning" sx={{ mt: 1.5, borderRadius: `${themeTokens.borderRadius.lg}px` }}>
            {t('nearMe.error')}
          </Alert>
        )}

        {showingNearMeResults && (
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
          {showingNearMeResults ? (
            <NearMeResults
              gyms={nearMeGyms}
              totalCount={nearMeData.totalCount}
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
          {/* The toggle is live at EVERY width, not just below the breakpoint.
              The tiles are this page's only third-party request, and a map that
              renders itself on every wide-screen view hands the visitor's IP to
              tile.openstreetmap.org without them asking for a map — on a page
              that goes public when #4382 drops the noindex. So it is a click,
              and the column below is sticky once it is open. */}
          <Button
            variant="outlined"
            startIcon={<MapOutlined />}
            onClick={() => setMapOpen((open) => !open)}
            sx={{ textTransform: 'none', mb: 1.5 }}
          >
            {mapOpen ? t('map.hideMap') : t('map.showMap')}
          </Button>
          {/* Hidden with `display: none`, which is what keeps the Leaflet
              bundle undownloaded until then: the map's effect waits for its
              container to report a non-zero size. */}
          <Box sx={{ display: mapOpen ? 'block' : 'none' }}>
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
  /** Everything in range, which is not always what fits in one request. */
  totalCount: number;
  origin: { latitude: number; longitude: number } | null;
  radiusKm: NearMeRadiusKm;
  locale: Locale;
  viewerState: GymClaimViewerState;
};

function NearMeResults({ gyms, totalCount, origin, radiusKm, locale, viewerState }: NearMeResultsProps) {
  const { t } = useTranslation('gyms');
  const formatNumber = numberFormatFor(locale);
  // The request is capped at the backend's 50 and near-me has no pagination, so
  // at 100 km around a dense metro the list is a truncation. Saying "50 gyms
  // within 100 km" there is simply false, and the pinless notice covers a
  // different gap.
  const truncated = totalCount > gyms.length;

  return (
    <>
      <Typography
        variant="subtitle1"
        component="h2"
        sx={{ fontWeight: themeTokens.typography.fontWeight.semibold, mb: 1.5 }}
      >
        {truncated
          ? t('nearMe.resultsHeadingCapped', {
              count: totalCount,
              shown: formatNumber.format(gyms.length),
              formattedCount: formatNumber.format(totalCount),
              radius: radiusKm,
            })
          : t('nearMe.resultsHeading', {
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
