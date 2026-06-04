import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GET_SESSION_DETAIL,
  UPDATE_INFERRED_SESSION,
  type GetSessionDetailQueryResponse,
} from '@boardsesh/graphql/operations';
import type { SessionDetail, UpdateInferredSessionInput } from '@boardsesh/shared-schema';
import { GET_SESSION, type GetSessionQueryResponse, type SessionPreview } from '../operations';
import { getHttpClient } from '../client';

const SESSION_DETAIL_STALE_TIME_MS = 30 * 1000;

/**
 * Full detail for a single past session (the Strava-style activity view):
 * aggregate stats, participant breakdown, grade distribution, and the full
 * per-climb tick list. Backed by the shared `GET_SESSION_DETAIL` operation,
 * which is reused unchanged from web.
 */
export function useSessionDetail(sessionId: string | undefined) {
  return useQuery({
    queryKey: ['sessionDetail', sessionId],
    queryFn: () =>
      getHttpClient()
        .request<GetSessionDetailQueryResponse>(GET_SESSION_DETAIL, { sessionId })
        .then((response) => response.sessionDetail),
    enabled: !!sessionId,
    staleTime: SESSION_DETAIL_STALE_TIME_MS,
  });
}

type UpdateInferredSessionResponse = {
  updateInferredSession: SessionDetail;
};

/**
 * Rename / edit the goal of an inferred session the user owns. Patches the
 * cached detail and invalidates the session feed so both surfaces reflect the
 * edit. Web maps the user-facing "goal" onto the `description` input field.
 */
export function useUpdateInferredSession(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<UpdateInferredSessionInput, 'sessionId'>) =>
      getHttpClient()
        .request<UpdateInferredSessionResponse>(UPDATE_INFERRED_SESSION, { input: { sessionId, ...input } })
        .then((response) => response.updateInferredSession),
    onSuccess: (updated) => {
      queryClient.setQueryData<SessionDetail | null>(['sessionDetail', sessionId], (prev) =>
        prev ? { ...prev, ...updated } : updated,
      );
      void queryClient.invalidateQueries({ queryKey: ['sessionGroupedFeed'] });
    },
  });
}

/**
 * Read-only session preview for the join-confirmation screen: host, board,
 * participant roster, and whether the session has ended. Does NOT join the
 * session — see `QueueProvider.joinSession`.
 */
export function useSessionPreview(sessionId: string | undefined) {
  return useQuery<SessionPreview | null>({
    queryKey: ['sessionPreview', sessionId],
    queryFn: () =>
      getHttpClient()
        .request<GetSessionQueryResponse>(GET_SESSION, { sessionId })
        .then((response) => response.session),
    enabled: !!sessionId,
    // Preview reflects live presence; keep it fresh while the screen is open.
    staleTime: 10 * 1000,
  });
}
