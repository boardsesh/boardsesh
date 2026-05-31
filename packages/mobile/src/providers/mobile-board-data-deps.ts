// Builds the platform-injected `*Deps` for the shared `@boardsesh/board-react`
// hooks from mobile's environment (auth provider, HTTP + WS GraphQL clients,
// toast + i18n). Mirrors web's `web-board-data-deps.ts`. Used by both
// BoardProvider (active board) and the play-drawer tick UIs (per-climb board),
// so the deps wiring lives in exactly one place.

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { execute } from '@boardsesh/graphql-client';
import type { LogbookDeps, SaveTickDeps, SaveClimbDeps, UpdateClimbDeps } from '@boardsesh/board-react';
import { useAuth } from './auth-provider';
import { useToast } from './toast-provider';
import { getHttpClient } from '../lib/graphql/client';
import { getWsClient } from '../lib/graphql/ws-client';

// HTTP for ticks/logbook (auth auto-injected by authenticatedFetch); WS for
// climb create/update (mirrors the queue mutations).
function requestHttp<TData>(document: string, variables?: Record<string, unknown>): Promise<TData> {
  return getHttpClient().request<TData>(document, variables);
}
function requestWs<TData>(document: string, variables?: Record<string, unknown>): Promise<TData> {
  return execute<TData>(getWsClient(), { query: document, variables });
}

export function useMobileLogbookDeps(): LogbookDeps {
  const { isAuthenticated } = useAuth();
  return useMemo<LogbookDeps>(() => ({ isAuthenticated, requestHttp }), [isAuthenticated]);
}

export function useMobileSaveTickDeps(): SaveTickDeps {
  const { isAuthenticated } = useAuth();
  return useMemo<SaveTickDeps>(
    () => ({
      assertAuthed: () => {
        if (!isAuthenticated) throw new Error('Not authenticated');
      },
      requestHttp,
    }),
    [isAuthenticated],
  );
}

export function useMobileSaveClimbDeps(): SaveClimbDeps {
  const { isAuthenticated } = useAuth();
  const { showToast } = useToast();
  const { t } = useTranslation('climbs');
  const queryClient = useQueryClient();
  return useMemo<SaveClimbDeps>(
    () => ({
      assertAuthed: () => {
        if (!isAuthenticated) throw new Error('Authentication required to create climbs');
      },
      requestWs,
      onSaveClimbError: () => showToast(t('createClimbForm.alerts.saveFailedFallback'), 'error'),
      onSaved: () => {
        void queryClient.invalidateQueries({ queryKey: ['searchClimbs'] });
        void queryClient.invalidateQueries({ queryKey: ['climb'] });
      },
    }),
    [isAuthenticated, showToast, t, queryClient],
  );
}

export function useMobileUpdateClimbDeps(): UpdateClimbDeps {
  const { isAuthenticated } = useAuth();
  const { showToast } = useToast();
  const { t } = useTranslation('climbs');
  const queryClient = useQueryClient();
  return useMemo<UpdateClimbDeps>(
    () => ({
      assertAuthed: () => {
        if (!isAuthenticated) throw new Error('Authentication required to update climbs');
      },
      requestWs,
      onError: () => showToast(t('createClimbForm.alerts.saveFailedFallback'), 'error'),
      onSaved: () => {
        void queryClient.invalidateQueries({ queryKey: ['searchClimbs'] });
        void queryClient.invalidateQueries({ queryKey: ['climb'] });
      },
    }),
    [isAuthenticated, showToast, t, queryClient],
  );
}
