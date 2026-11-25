'use client';

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import Box from '@mui/material/Box';
import MuiTypography from '@mui/material/Typography';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { useDebouncedValue } from '@/app/hooks/use-debounced-value';
import {
  FIND_SIMILAR_GYMS,
  type FindSimilarGymsQueryResponse,
  type FindSimilarGymsQueryVariables,
} from '@boardsesh/graphql/operations';
import type { SimilarGym } from '@boardsesh/shared-schema';
import { themeTokens } from '@/app/theme/theme-config';
import SimilarGymList from './similar-gym-list';

type SimilarGymSuggestionsProps = {
  name: string;
  latitude: number | null;
  longitude: number | null;
};

const MIN_NAME_LENGTH = 3;

export default function SimilarGymSuggestions({ name, latitude, longitude }: SimilarGymSuggestionsProps) {
  const { t } = useTranslation('boards');
  const { token } = useWsAuthToken();

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

      <SimilarGymList gyms={suggestions} claimPlacement="similar-gyms" />

      <MuiTypography variant="caption" color="text.secondary">
        {t('similarGyms.createAnyway')}
      </MuiTypography>
    </Box>
  );
}
