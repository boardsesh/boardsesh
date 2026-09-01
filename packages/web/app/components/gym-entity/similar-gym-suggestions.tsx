'use client';

import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import MuiButton from '@mui/material/Button';
import MuiTypography from '@mui/material/Typography';
import LocationOnOutlined from '@mui/icons-material/LocationOnOutlined';
import OpenInNewOutlined from '@mui/icons-material/OpenInNewOutlined';
import VerifiedOutlined from '@mui/icons-material/VerifiedOutlined';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { useDebouncedValue } from '@/app/hooks/use-debounced-value';
import LocaleLink from '@/app/components/i18n/locale-link';
import {
  FIND_SIMILAR_GYMS,
  type FindSimilarGymsQueryResponse,
  type FindSimilarGymsQueryVariables,
} from '@boardsesh/graphql/operations';
import type { SimilarGym } from '@boardsesh/shared-schema';
import { gymClaimCtaClicked } from '@boardsesh/analytics';
import { trackGymFunnelEvent, viewerStateFrom } from '@/app/lib/gym-funnel-analytics';
import { themeTokens } from '@/app/theme/theme-config';
import ClaimGymDialog from './claim-gym-dialog';

type SimilarGymSuggestionsProps = {
  name: string;
  latitude: number | null;
  longitude: number | null;
};

const MIN_NAME_LENGTH = 3;

function capitalize(value: string): string {
  return value.length > 0 ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

export default function SimilarGymSuggestions({ name, latitude, longitude }: SimilarGymSuggestionsProps) {
  const { t } = useTranslation('boards');
  // `isAuthenticated` rather than useSession().status — the suggestion query
  // this list renders from is itself gated on the token, so by the time a claim
  // button exists the session has settled.
  const { token, isAuthenticated } = useWsAuthToken();
  const [claimTarget, setClaimTarget] = useState<SimilarGym | null>(null);

  // Debounce the whole lookup input so typing a name (and nudging the map) fires
  // at most one request per pause instead of one per keystroke.
  const debounced = useDebouncedValue(
    useMemo(() => ({ name: name.trim(), latitude, longitude }), [name, latitude, longitude]),
    400,
  );

  const enabled = Boolean(token) && debounced.name.length >= MIN_NAME_LENGTH;

  const { data } = useQuery<SimilarGym[]>({
    queryKey: ['findSimilarGyms', debounced.name, debounced.latitude, debounced.longitude],
    enabled,
    staleTime: 30_000,
    // Don't re-hammer a rate-limited (or otherwise failing) lookup — it's an
    // as-you-type convenience, not a critical fetch.
    retry: false,
    queryFn: async () => {
      const client = createGraphQLHttpClient(token);
      const response = await client.request<FindSimilarGymsQueryResponse, FindSimilarGymsQueryVariables>(
        FIND_SIMILAR_GYMS,
        {
          input: {
            name: debounced.name,
            latitude: debounced.latitude ?? undefined,
            longitude: debounced.longitude ?? undefined,
          },
        },
      );
      return response.findSimilarGyms;
    },
  });

  const suggestions = data ?? [];
  if (suggestions.length === 0) return null;

  const formatDistance = (distanceMeters: number | null | undefined): string | null => {
    if (distanceMeters == null) return null;
    if (distanceMeters < 1000) {
      return t('similarGyms.distanceMeters', { meters: Math.round(distanceMeters) });
    }
    return t('similarGyms.distanceKm', { km: (distanceMeters / 1000).toFixed(1) });
  };

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 1.5,
        p: 2,
        borderRadius: `${themeTokens.borderRadius.lg}px`,
        backgroundColor: 'var(--neutral-50)',
        border: '1px solid var(--neutral-200)',
      }}
    >
      <Box>
        <MuiTypography variant="subtitle2" sx={{ fontWeight: themeTokens.typography.fontWeight.semibold }}>
          {t('similarGyms.heading')}
        </MuiTypography>
        <MuiTypography variant="body2" color="text.secondary">
          {t('similarGyms.subtitle')}
        </MuiTypography>
      </Box>

      <Stack spacing={1}>
        {suggestions.map((gym) => {
          const distanceLabel = formatDistance(gym.distanceMeters);
          // /gym/[slug] resolves via gymBySlug, which can't resolve a uuid — so
          // only offer the link when there's a real slug.
          const gymHref = gym.slug ? `/gym/${gym.slug}` : null;
          return (
            <Card key={gym.uuid} variant="outlined" sx={{ borderRadius: `${themeTokens.borderRadius.md}px` }}>
              <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
                <MuiTypography
                  variant="subtitle2"
                  sx={{
                    fontWeight: themeTokens.typography.fontWeight.semibold,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {gym.name}
                </MuiTypography>

                {gym.address && (
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.25 }}>
                    <LocationOnOutlined sx={{ fontSize: 14, color: 'var(--neutral-400)' }} />
                    <MuiTypography
                      variant="body2"
                      color="text.secondary"
                      sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {gym.address}
                    </MuiTypography>
                  </Box>
                )}

                <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.75, mt: 1 }}>
                  {distanceLabel && <Chip size="small" variant="outlined" label={distanceLabel} />}
                  {gym.providerOrigins.map((origin) => (
                    <Chip
                      key={origin}
                      size="small"
                      color="primary"
                      variant="outlined"
                      icon={<VerifiedOutlined sx={{ fontSize: 14 }} />}
                      label={t('similarGyms.providerBadge', { provider: capitalize(origin) })}
                    />
                  ))}
                </Box>

                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1.5 }}>
                  {gymHref && (
                    <MuiButton
                      component={LocaleLink}
                      href={gymHref}
                      size="small"
                      variant="text"
                      startIcon={<OpenInNewOutlined />}
                      sx={{ textTransform: 'none' }}
                    >
                      {t('similarGyms.viewGym')}
                    </MuiButton>
                  )}
                  {gym.isClaimable && (
                    <MuiButton
                      size="small"
                      variant="contained"
                      onClick={() => {
                        trackGymFunnelEvent(
                          gymClaimCtaClicked({
                            placement: 'similar-gyms',
                            viewerState: viewerStateFrom(isAuthenticated),
                            gymUuid: gym.uuid,
                          }),
                        );
                        setClaimTarget(gym);
                      }}
                      sx={{ textTransform: 'none' }}
                    >
                      {t('similarGyms.claim')}
                    </MuiButton>
                  )}
                </Box>
              </CardContent>
            </Card>
          );
        })}
      </Stack>

      <MuiTypography variant="caption" color="text.secondary">
        {t('similarGyms.createAnyway')}
      </MuiTypography>

      {claimTarget && (
        <ClaimGymDialog
          gymUuid={claimTarget.uuid}
          gymName={claimTarget.name}
          website={claimTarget.website}
          canClaimByDomain={claimTarget.canClaimByDomain}
          open={claimTarget !== null}
          onClose={() => setClaimTarget(null)}
        />
      )}
    </Box>
  );
}
