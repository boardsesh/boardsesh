'use client';

import { useQuery } from '@tanstack/react-query';
import { useWsAuthToken } from './use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  GET_SESSION_WORKOUTS,
  type GetSessionWorkoutsQueryResponse,
  type SessionWorkoutResult,
} from '@boardsesh/graphql/operations/session-workouts';

export const SESSION_WORKOUTS_QUERY_KEY = (sessionId: string) => ['sessionWorkouts', sessionId] as const;

const EMPTY: SessionWorkoutResult[] = [];

/**
 * The workouts followed in a session (#6903). Mirrors `useSessionDetail`: the
 * server-rendered copy is the signed-out answer, so a signed-in viewer
 * refetches once their token is in (a crewmate may then see more), and a
 * signed-out viewer keeps the copy.
 */
export function useSessionWorkouts({
  sessionId,
  initialData,
}: {
  sessionId?: string;
  initialData?: SessionWorkoutResult[] | null;
}): SessionWorkoutResult[] {
  const { token, isAuthenticated } = useWsAuthToken();
  const isDailyGroup = !!sessionId?.startsWith('daily:');

  const query = useQuery<SessionWorkoutResult[]>({
    queryKey: SESSION_WORKOUTS_QUERY_KEY(sessionId ?? ''),
    queryFn: async () => {
      const client = createGraphQLHttpClient(token);
      const data = await client.request<GetSessionWorkoutsQueryResponse>(GET_SESSION_WORKOUTS, { sessionId });
      return data.sessionWorkouts;
    },
    enabled: !!sessionId && !isDailyGroup && isAuthenticated && !!token,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    ...(initialData ? { initialData, initialDataUpdatedAt: 0 } : {}),
  });

  return query.data ?? initialData ?? EMPTY;
}
