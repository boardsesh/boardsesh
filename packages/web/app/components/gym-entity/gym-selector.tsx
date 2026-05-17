'use client';

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import MuiTypography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import AddOutlined from '@mui/icons-material/AddOutlined';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { GET_MY_GYMS, type GetMyGymsQueryVariables, type GetMyGymsQueryResponse } from '@/app/lib/graphql/operations';
import type { Gym } from '@boardsesh/shared-schema';
import { persistUser } from '@/app/lib/react-query-persist-meta';
import CreateGymForm from './create-gym-form';

type GymSelectorProps = {
  selectedGymUuid: string | null;
  onSelect: (gymUuid: string | null) => void;
};

export default function GymSelector({ selectedGymUuid, onSelect }: GymSelectorProps) {
  const { t } = useTranslation('boards');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const { token } = useWsAuthToken();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['myGyms'],
    queryFn: async () => {
      const client = createGraphQLHttpClient(token);
      const response = await client.request<GetMyGymsQueryResponse, GetMyGymsQueryVariables>(GET_MY_GYMS, {
        input: { limit: 50 },
      });
      return response.myGyms.gyms;
    },
    enabled: !!token,
    staleTime: 5 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnMount: 'always',
    meta: persistUser,
  });

  const gyms = data ?? [];

  const handleGymCreated = (gym: Gym) => {
    queryClient.setQueryData<Gym[]>(['myGyms'], (prev) => (prev ? [gym, ...prev] : [gym]));
    onSelect(gym.uuid);
    setShowCreateForm(false);
  };

  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 1 }}>
        <CircularProgress size={16} />
        <MuiTypography variant="body2" color="text.secondary">
          {t('gymSelector.loading')}
        </MuiTypography>
      </Box>
    );
  }

  if (showCreateForm) {
    return <CreateGymForm onSuccess={handleGymCreated} onCancel={() => setShowCreateForm(false)} />;
  }

  return (
    <Box>
      <MuiTypography variant="body2" sx={{ mb: 1 }}>
        {t('gymSelector.linkToGym')}
      </MuiTypography>
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        <Chip
          label={t('gymSelector.noGym')}
          variant={selectedGymUuid === null ? 'filled' : 'outlined'}
          color={selectedGymUuid === null ? 'primary' : 'default'}
          onClick={() => onSelect(null)}
          size="small"
        />
        {gyms.map((gym) => (
          <Chip
            key={gym.uuid}
            label={gym.name}
            variant={selectedGymUuid === gym.uuid ? 'filled' : 'outlined'}
            color={selectedGymUuid === gym.uuid ? 'primary' : 'default'}
            onClick={() => onSelect(gym.uuid)}
            size="small"
          />
        ))}
        <Chip
          icon={<AddOutlined />}
          label={t('gymSelector.createNew')}
          variant="outlined"
          onClick={() => setShowCreateForm(true)}
          size="small"
        />
      </Box>
    </Box>
  );
}
