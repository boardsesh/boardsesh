import { useQuery } from '@tanstack/react-query';
import { getAuroraCredentials } from '../aurora-credentials';

// The prompt and Connected apps share one cached response and invalidation key.
export const AURORA_CREDENTIALS_QUERY_KEY = ['auroraCredentials'] as const;

export function useBoardAccountCredentials(enabled = true) {
  return useQuery({
    queryKey: AURORA_CREDENTIALS_QUERY_KEY,
    queryFn: getAuroraCredentials,
    networkMode: 'offlineFirst',
    enabled,
    select: (response) => response.credentials,
  });
}
