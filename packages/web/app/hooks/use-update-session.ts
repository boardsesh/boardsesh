'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useWsAuthToken } from './use-ws-auth-token';
import { useSession } from 'next-auth/react';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { SESSION_DETAIL_QUERY_KEY } from './use-session-detail';
import type { SessionDetail } from '@boardsesh/shared-schema';
import { UPDATE_SESSION, type UpdateSessionVariables, type UpdateSessionResponse } from '@boardsesh/graphql/operations';

type UpdateSessionInput = UpdateSessionVariables['input'];

type UseUpdateSessionOptions = {
  /**
   * Fallback message shown in the error snackbar when the server doesn't return
   * a specific GraphQL error. Call sites pass their own copy (e.g. the summary
   * dialog's "Couldn't save your notes" string).
   */
  errorMessage?: string;
};

/**
 * Hook to update a session's editable metadata (name / notes) via GraphQL.
 *
 * Semantics mirror the backend: omit a field to leave it unchanged, pass null
 * or an empty string to clear it. Creator-only — the server rejects others.
 * On success the canonical values are merged into the session-detail cache and
 * the session feed is invalidated so cards pick up the change.
 */
export function useUpdateSession(options?: UseUpdateSessionOptions) {
  const { token } = useWsAuthToken();
  const { status: sessionStatus } = useSession();
  const { showMessage } = useSnackbar();
  const queryClient = useQueryClient();
  const fallbackErrorMessage = options?.errorMessage;

  return useMutation({
    mutationFn: async (input: UpdateSessionInput) => {
      if (sessionStatus !== 'authenticated') {
        throw new Error('Not authenticated');
      }
      if (!token) {
        throw new Error('Auth token not available');
      }

      const client = createGraphQLHttpClient(token);
      const variables: UpdateSessionVariables = { input };
      const response = await client.request<UpdateSessionResponse>(UPDATE_SESSION, variables);
      return response.updateSession;
    },
    onSuccess: (result) => {
      queryClient.setQueryData<SessionDetail | null>(SESSION_DETAIL_QUERY_KEY(result.sessionId), (previous) => {
        if (!previous) return previous;
        return {
          ...previous,
          sessionName: result.name ?? null,
          notes: result.notes ?? null,
        };
      });
      void queryClient.invalidateQueries({ queryKey: ['sessionDetail'] });
      void queryClient.invalidateQueries({ queryKey: ['sessionFeed'] });
    },
    onError: (err) => {
      // A specific server-provided GraphQL error wins (e.g. "You can only edit
      // your own sessions"); otherwise fall back to the call site's copy.
      let errorMessage = fallbackErrorMessage ?? 'Failed to update session';
      if (err instanceof Error) {
        if ('response' in err && typeof err.response === 'object' && err.response !== null) {
          const response = err.response as { errors?: Array<{ message: string }> };
          if (response.errors && response.errors.length > 0) {
            errorMessage = response.errors[0].message;
          }
        } else if (!fallbackErrorMessage && err.message) {
          errorMessage = err.message;
        }
      }
      showMessage(errorMessage, 'error');
    },
  });
}
