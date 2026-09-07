import { useQuery } from '@tanstack/react-query';
import { getAuroraCredentials } from '../aurora-credentials';

/**
 * Which board accounts this climber has linked.
 *
 * The query key is deliberately the SAME tuple `BoardAccountsSection` uses, so the
 * two share one cache entry and one request rather than double-fetching whenever
 * both are mounted — and so a link made on the Connected apps screen invalidates
 * this read for free.
 *
 * The eligibility rules that consume this live in `board-link-eligibility.ts`, which
 * imports nothing native, so they stay testable without this module's dependency on
 * `expo-web-browser`.
 */
export const AURORA_CREDENTIALS_QUERY_KEY = ['auroraCredentials'] as const;

export function useBoardAccountCredentials(enabled = true) {
  return useQuery({
    queryKey: AURORA_CREDENTIALS_QUERY_KEY,
    queryFn: getAuroraCredentials,
    enabled,
    select: (response) => response.credentials,
  });
}
