'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import MyLocationOutlined from '@mui/icons-material/MyLocationOutlined';
import { useGeolocation } from '@/app/hooks/use-geolocation';
import type { Locale } from '@/app/lib/i18n/config';
import { localeHref } from '@/app/lib/i18n/locale-href';
import { buildDirectoryHref } from '@/app/gyms/directory-facets';
import { DEFAULT_NEAR_ME_RADIUS_KM, nearMeFallbackReason, roundCoordinate } from '@/app/gyms/near-me-model';
import { themeTokens } from '@/app/theme/theme-config';

type HomeGymSearchNearMeProps = {
  locale: Locale;
};

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

/**
 * The homepage's one interactive part: "Use my location".
 *
 * Deliberately the SMALLEST client island in the section. Everything around it
 * — the heading, the copy, the board chips, the gym cards and their anchors —
 * is server-rendered, because that block exists for a crawler as much as for a
 * person. This button only has to exist in the browser because geolocation
 * does.
 *
 * It navigates to `/gyms?lat=…&lng=…&radius=…` rather than fetching gyms here.
 * The directory already renders that URL, with its map, its radius control and
 * its honest "near me hides pinless gyms" notice, so a second near-me
 * implementation on the homepage would be a worse copy of a page one click
 * away. The homepage's job is to get somebody there.
 *
 * With JavaScript off this control is simply not there and the text form beside
 * it still submits — which is why the hint under the row names typing a town as
 * a first-class path rather than a consolation.
 */
export default function HomeGymSearchNearMe({ locale }: HomeGymSearchNearMeProps) {
  const { t } = useTranslation('gyms');
  const router = useRouter();

  // Called with NO argument: `useGeolocation(options)` lists `options` in a
  // `useCallback` dependency array, so an inline object literal would rebuild
  // the position getter on every render.
  const { coordinates, error, loading, requestPermission } = useGeolocation();

  // Resolved in an effect, not at render: `navigator` does not exist during
  // SSR, and a render-time read would make the server and the first client
  // render disagree.
  const [geolocationSupported, setGeolocationSupported] = useState(true);
  useEffect(() => {
    setGeolocationSupported(typeof navigator !== 'undefined' && 'geolocation' in navigator);
  }, []);

  // Set only by a press. Without it, a coordinate that arrives from some other
  // consumer of the hook would navigate somebody who never asked to go.
  const awaitingFixRef = useRef(false);

  const goToDirectory = useCallback(
    (latitude: number, longitude: number) => {
      // Rounded before it leaves the browser (~110 m), same as the directory's
      // own near-me mode. It is about to land in a shareable URL.
      const href = buildDirectoryHref(
        'all',
        {
          query: '',
          boardTypes: [],
          latitude: roundCoordinate(latitude),
          longitude: roundCoordinate(longitude),
          radiusKm: DEFAULT_NEAR_ME_RADIUS_KM,
          page: 1,
        },
        1,
      );
      router.push(localeHref(href, locale));
    },
    [locale, router],
  );

  useEffect(() => {
    if (!awaitingFixRef.current || !coordinates) return;
    awaitingFixRef.current = false;
    goToDirectory(coordinates.latitude, coordinates.longitude);
  }, [coordinates, goToDirectory]);

  const handleUseMyLocation = useCallback(() => {
    if (coordinates) {
      goToDirectory(coordinates.latitude, coordinates.longitude);
      return;
    }
    awaitingFixRef.current = true;
    void requestPermission();
  }, [coordinates, goToDirectory, requestPermission]);

  const fallbackReason = nearMeFallbackReason({ geolocationSupported, error });

  // A fragment, not a wrapper: the button and its hint are laid out by the
  // search panel's flex row, and a div between them would break that row.
  return (
    <>
      <Button
        type="button"
        variant="outlined"
        startIcon={<MyLocationOutlined />}
        onClick={handleUseMyLocation}
        disabled={loading || fallbackReason === 'unsupported'}
        sx={{
          textTransform: 'none',
          minHeight: 44,
          fontSize: themeTokens.typography.fontSize.base,
          borderColor: 'var(--separator)',
          color: 'var(--neutral-900)',
          '&:hover': { borderColor: 'var(--color-primary)' },
        }}
      >
        {loading ? t('nearMe.locating') : t('nearMe.cta')}
      </Button>

      {/* `unsupported` shows unprompted, because the button is disabled on a
          browser with no geolocation API — waiting for a press would mean the
          hint never appears on the one browser that only has the text path. */}
      {fallbackReason !== null && (
        <Alert severity="info" sx={{ flexBasis: '100%', borderRadius: `${themeTokens.borderRadius.lg}px` }}>
          {fallbackBody(t, fallbackReason)}
        </Alert>
      )}
    </>
  );
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
