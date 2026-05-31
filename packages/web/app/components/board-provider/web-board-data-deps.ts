'use client';

// Builds the platform-injected `*Deps` for the shared `@boardsesh/board-react`
// hooks from web's environment (NextAuth session, ws-auth token, the HTTP +
// WebSocket GraphQL clients, the MUI snackbar, i18n, IndexedDB tick drafts).
// This is the single seam where web-only I/O is wired in — the hooks themselves
// live in the shared package and run identically on mobile with different deps.

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from 'next-auth/react';
import type { LogbookDeps, SaveTickDeps, SaveClimbDeps, UpdateClimbDeps } from '@boardsesh/board-react';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { createGraphQLClient, execute } from '@/app/components/graphql-queue/graphql-client';
import { getBackendWsUrl } from '@/app/lib/backend-url';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { clearTickDraft } from '@/app/lib/tick-draft-db';

/** Logbook fetch deps — gated reactively on authenticated session + token. */
export function useWebLogbookDeps(): LogbookDeps {
  const { token } = useWsAuthToken();
  const { status } = useSession();
  const isAuthenticated = status === 'authenticated' && !!token;

  return useMemo<LogbookDeps>(
    () => ({
      isAuthenticated,
      requestHttp: <TData>(document: string, variables?: Record<string, unknown>) =>
        createGraphQLHttpClient(token).request<TData>(document, variables),
    }),
    [isAuthenticated, token],
  );
}

/** Tick save deps — preserves web's two distinct auth messages + IndexedDB draft clear. */
export function useWebSaveTickDeps(): SaveTickDeps {
  const { token } = useWsAuthToken();
  const { status } = useSession();

  return useMemo<SaveTickDeps>(
    () => ({
      assertAuthed: () => {
        if (status !== 'authenticated') throw new Error('Not authenticated');
        if (!token) throw new Error('Auth token not available');
      },
      requestHttp: <TData>(document: string, variables?: Record<string, unknown>) =>
        createGraphQLHttpClient(token).request<TData>(document, variables),
      clearTickDraft: (climbUuid: string, angle: number) => void clearTickDraft(climbUuid, angle),
    }),
    [status, token],
  );
}

/** Climb create deps — fresh WS client per call (disposed), snackbar on failure. */
export function useWebSaveClimbDeps(): SaveClimbDeps {
  const { token } = useWsAuthToken();
  const { data: session, status } = useSession();
  const { showMessage } = useSnackbar();
  const { t } = useTranslation('climbs');

  return useMemo<SaveClimbDeps>(
    () => ({
      assertAuthed: () => {
        if (status !== 'authenticated' || !session?.user?.id || !token) {
          throw new Error('Authentication required to create climbs');
        }
      },
      requestWs: async <TData>(document: string, variables?: Record<string, unknown>) => {
        // Fresh client per mutation to avoid stale token refs; disposed after.
        const client = createGraphQLClient({ url: getBackendWsUrl()!, authToken: token });
        try {
          return await execute<TData>(client, { query: document, variables });
        } finally {
          void client.dispose();
        }
      },
      onSaveClimbError: () => showMessage(t('createClimbForm.alerts.saveFailedFallback'), 'error'),
    }),
    [status, session?.user?.id, token, showMessage, t],
  );
}

/** Climb update deps — owner/draft window enforced by the backend; no error UI (caller handles). */
export function useWebUpdateClimbDeps(): UpdateClimbDeps {
  const { token } = useWsAuthToken();
  const { data: session, status } = useSession();

  return useMemo<UpdateClimbDeps>(
    () => ({
      assertAuthed: () => {
        if (status !== 'authenticated' || !session?.user?.id || !token) {
          throw new Error('Authentication required to update climbs');
        }
      },
      requestWs: async <TData>(document: string, variables?: Record<string, unknown>) => {
        const client = createGraphQLClient({ url: getBackendWsUrl()!, authToken: token });
        try {
          return await execute<TData>(client, { query: document, variables });
        } finally {
          void client.dispose();
        }
      },
    }),
    [status, session?.user?.id, token],
  );
}
