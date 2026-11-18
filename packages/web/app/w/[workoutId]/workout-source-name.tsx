'use client';

import { useQuery } from '@tanstack/react-query';
import Typography from '@mui/material/Typography';
import { useTranslation } from 'react-i18next';
import { executeGraphQL } from '@/app/lib/graphql/client';

/** Fetch from the visitor's browser so the backend can rate-limit its real ingress IP. */
export function WorkoutSourceName({ workoutId }: { workoutId: string }) {
  const { t } = useTranslation('session');
  const { data: sourceName } = useQuery({
    queryKey: ['publicAppWorkoutLaunch', workoutId],
    queryFn: async () => {
      const response = await executeGraphQL<{
        publicAppWorkoutLaunch: { sourceAppName: string } | null;
      }>('query PublicAppWorkoutLaunch($id: ID!) { publicAppWorkoutLaunch(id: $id) { sourceAppName } }', {
        id: workoutId,
      });
      return response.publicAppWorkoutLaunch?.sourceAppName ?? null;
    },
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  return sourceName ? <Typography>{t('partnerWorkouts.from', { app: sourceName })}</Typography> : null;
}
