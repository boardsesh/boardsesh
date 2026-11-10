'use client';

import React, { useCallback, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import AddOutlined from '@mui/icons-material/AddOutlined';
import AppsOutlined from '@mui/icons-material/AppsOutlined';
import LockOutlined from '@mui/icons-material/LockOutlined';
import PauseCircleOutlined from '@mui/icons-material/PauseCircleOutlined';
import ReplayOutlined from '@mui/icons-material/ReplayOutlined';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { useTranslation } from 'react-i18next';
import {
  CREATE_OAUTH_CLIENT,
  DELETE_OAUTH_CLIENT,
  GET_MY_OAUTH_CLIENTS,
  ROTATE_OAUTH_CLIENT_SECRET,
  UPDATE_OAUTH_CLIENT,
  type CreateOAuthClientMutationResponse,
  type CreateOAuthClientMutationVariables,
  type DeleteOAuthClientMutationResponse,
  type DeleteOAuthClientMutationVariables,
  type MyOAuthClientsQueryResponse,
  type RotateOAuthClientSecretMutationResponse,
  type RotateOAuthClientSecretMutationVariables,
  type UpdateOAuthClientMutationResponse,
  type UpdateOAuthClientMutationVariables,
} from '@boardsesh/graphql/operations';
import type { OAuthClient } from '@boardsesh/shared-schema';
import { StatePanel } from '@/app/components/ui/page-shell';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { isEmptyUpdate, toCreateInput, toUpdateInput, type AppFormState } from '@/app/lib/developer-apps/app-form';
import { classifyConsoleError, type ConsoleProblem } from '@/app/lib/developer-apps/console-errors';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import AppCard from './app-card';
import AppFormDialog from './app-form-dialog';
import ConfirmActionDialog from './confirm-action-dialog';
import SecretDialog, { type RevealedCredentials } from './secret-dialog';

/** Decision 22's launch caps and the per-developer cap, as the backend applies them. */
const APPS_PER_DEVELOPER = 10;
const LAUNCH_ACTIVE_CONNECTIONS = 25;
const LAUNCH_NEW_CONNECTIONS_PER_DAY = 20;

type FormTarget = { kind: 'create' } | { kind: 'edit'; app: OAuthClient };
type PendingAction = { kind: 'rotate' | 'delete'; app: OAuthClient };

function developerAppsKey(viewerId: string) {
  return ['developerApps', viewerId] as const;
}

/**
 * The developer console: list, register, edit, rotate and delete partner apps,
 * all through the backend's GraphQL operations.
 *
 * A client secret never enters React Query, a URL or a log. Create and rotate
 * run as plain requests whose result goes straight into `revealed`, which only
 * the secret dialog reads and which is cleared when it closes. The list query
 * holds apps without secrets: the API has no field that could carry one.
 */
export default function DeveloperAppsContent() {
  const { t, i18n } = useTranslation('developers');
  const { data: session } = useSession();
  const { token, isLoading: tokenLoading } = useWsAuthToken();
  const { showMessage } = useSnackbar();
  const queryClient = useQueryClient();
  const viewerId = session?.user?.id ?? 'anonymous';
  const queryKey = useMemo(() => developerAppsKey(viewerId), [viewerId]);

  const [formTarget, setFormTarget] = useState<FormTarget | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [working, setWorking] = useState(false);
  const [revealed, setRevealed] = useState<RevealedCredentials | null>(null);

  const appsQuery = useQuery({
    queryKey,
    queryFn: async () =>
      (await createGraphQLHttpClient(token).request<MyOAuthClientsQueryResponse>(GET_MY_OAUTH_CLIENTS)).myOAuthClients,
    enabled: Boolean(token),
    // Only a transport failure is worth retrying; a refusal says the same thing twice.
    retry: (failureCount, error) => classifyConsoleError(error).kind === 'failed' && failureCount < 2,
  });

  const replaceApp = useCallback(
    (app: OAuthClient) =>
      queryClient.setQueryData<OAuthClient[]>(queryKey, (current) =>
        current?.map((existing) => (existing.clientId === app.clientId ? app : existing)),
      ),
    [queryClient, queryKey],
  );

  const problemMessage = useCallback(
    (problem: ConsoleProblem): string => {
      switch (problem.kind) {
        case 'invalid-input':
          return problem.message;
        case 'busy':
          return t('errors.busy');
        case 'rate-limited':
          return t('errors.rateLimited');
        case 'gone':
          return t('errors.gone');
        case 'suspended':
          return t('errors.suspended');
        case 'email-not-verified':
          return t('errors.emailNotVerified');
        case 'not-available':
          return t('states.notAvailable.title');
        case 'not-allowlisted':
          return t('states.notAllowlisted.title');
        case 'paused':
          return t('states.paused.body');
        default:
          return t('errors.generic');
      }
    },
    [t],
  );

  const onCopyFailed = useCallback(() => showMessage(t('secret.copyFailed'), 'error'), [showMessage, t]);

  /** Resolves with the text to show in the form, or null once saved. */
  const submitForm = async (state: AppFormState): Promise<string | null> => {
    if (!formTarget) return null;
    const client = createGraphQLHttpClient(token);
    try {
      if (formTarget.kind === 'create') {
        const { createOAuthClient: credentials } = await client.request<
          CreateOAuthClientMutationResponse,
          CreateOAuthClientMutationVariables
        >(CREATE_OAUTH_CLIENT, { input: toCreateInput(state) });
        queryClient.setQueryData<OAuthClient[]>(queryKey, (current) => [...(current ?? []), credentials.client]);
        setFormTarget(null);
        setRevealed({ app: credentials.client, clientSecret: credentials.clientSecret, reason: 'created' });
        return null;
      }
      const input = toUpdateInput(formTarget.app, state);
      if (!isEmptyUpdate(input)) {
        const { updateOAuthClient: updated } = await client.request<
          UpdateOAuthClientMutationResponse,
          UpdateOAuthClientMutationVariables
        >(UPDATE_OAUTH_CLIENT, { input });
        replaceApp(updated);
        showMessage(t('toasts.saved'), 'success');
      }
      setFormTarget(null);
      return null;
    } catch (error) {
      const problem = classifyConsoleError(error);
      if (problem.kind === 'gone' || problem.kind === 'suspended') {
        setFormTarget(null);
        showMessage(problemMessage(problem), 'error');
        void queryClient.invalidateQueries({ queryKey });
        return null;
      }
      return problemMessage(problem);
    }
  };

  const confirmPending = async () => {
    if (!pending) return;
    const client = createGraphQLHttpClient(token);
    setWorking(true);
    try {
      if (pending.kind === 'rotate') {
        const { rotateOAuthClientSecret: credentials } = await client.request<
          RotateOAuthClientSecretMutationResponse,
          RotateOAuthClientSecretMutationVariables
        >(ROTATE_OAUTH_CLIENT_SECRET, { clientId: pending.app.clientId });
        replaceApp(credentials.client);
        setRevealed({ app: credentials.client, clientSecret: credentials.clientSecret, reason: 'rotated' });
      } else {
        await client.request<DeleteOAuthClientMutationResponse, DeleteOAuthClientMutationVariables>(
          DELETE_OAUTH_CLIENT,
          { clientId: pending.app.clientId },
        );
        queryClient.setQueryData<OAuthClient[]>(queryKey, (current) =>
          current?.filter((existing) => existing.clientId !== pending.app.clientId),
        );
        showMessage(t('toasts.deleted', { app: pending.app.name }), 'success');
      }
      setPending(null);
    } catch (error) {
      const problem = classifyConsoleError(error);
      showMessage(problemMessage(problem), 'error');
      if (problem.kind === 'gone' || problem.kind === 'suspended') {
        setPending(null);
        void queryClient.invalidateQueries({ queryKey });
      }
    } finally {
      setWorking(false);
    }
  };

  const apps = appsQuery.data;
  const loading = tokenLoading || (Boolean(token) && appsQuery.isPending);
  // No token once loading is over: the sign-in could not be turned into one. A retry may help.
  const listProblem: ConsoleProblem | null = appsQuery.error
    ? classifyConsoleError(appsQuery.error)
    : !loading && !token
      ? { kind: 'failed' }
      : null;
  // The count the delete dialog states, from the list a delete request has just refreshed.
  const pendingApp = pending ? (apps?.find((app) => app.clientId === pending.app.clientId) ?? pending.app) : null;
  const atAppLimit = (apps?.length ?? 0) >= APPS_PER_DEVELOPER;
  const openCreate = () => setFormTarget({ kind: 'create' });

  const body = (() => {
    if (loading) {
      return (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 6, justifyContent: 'center' }} role="status">
          <CircularProgress size={24} aria-hidden />
          <Typography variant="body2" color="text.secondary">
            {t('states.loading')}
          </Typography>
        </Box>
      );
    }
    if (listProblem) {
      const gate = {
        'not-available': { icon: <LockOutlined />, key: 'notAvailable' },
        'not-allowlisted': { icon: <LockOutlined />, key: 'notAllowlisted' },
        paused: { icon: <PauseCircleOutlined />, key: 'paused' },
      } as const;
      if (listProblem.kind in gate) {
        const { icon, key } = gate[listProblem.kind as keyof typeof gate];
        // i18n-keep developers.states.notAvailable.title
        // i18n-keep developers.states.notAvailable.body
        // i18n-keep developers.states.notAllowlisted.title
        // i18n-keep developers.states.notAllowlisted.body
        // i18n-keep developers.states.paused.title
        // i18n-keep developers.states.paused.body
        return (
          <StatePanel
            tone="brand"
            icon={icon}
            title={t(`states.${key}.title`)}
            body={t(`states.${key}.body`)}
            actions={null}
          />
        );
      }
      return (
        <StatePanel
          tone="warning"
          icon={<ReplayOutlined />}
          title={t('states.failed.title')}
          body={t('states.failed.body')}
          actions={
            <Button variant="outlined" onClick={() => void appsQuery.refetch()}>
              {t('states.failed.retry')}
            </Button>
          }
        />
      );
    }
    if (!apps || apps.length === 0) {
      return (
        <StatePanel
          tone="brand"
          icon={<AppsOutlined />}
          title={t('states.empty.title')}
          body={t('states.empty.body')}
          actions={
            <Button variant="contained" startIcon={<AddOutlined />} onClick={openCreate}>
              {t('states.empty.action')}
            </Button>
          }
        />
      );
    }
    return (
      <Stack component="ul" spacing={2} sx={{ m: 0, p: 0 }}>
        {apps.map((app) => (
          <AppCard
            key={app.clientId}
            app={app}
            locale={i18n.language}
            onEdit={(target) => setFormTarget({ kind: 'edit', app: target })}
            onRotate={(target) => setPending({ kind: 'rotate', app: target })}
            onDelete={(target) => {
              setPending({ kind: 'delete', app: target });
              void appsQuery.refetch();
            }}
            onCopyFailed={onCopyFailed}
          />
        ))}
      </Stack>
    );
  })();

  return (
    <Box>
      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 2,
          mb: 3,
        }}
      >
        <Typography variant="body2" color="text.secondary" sx={{ flex: '1 1 18rem' }}>
          {t('page.limits', {
            apps: APPS_PER_DEVELOPER,
            connections: LAUNCH_ACTIVE_CONNECTIONS,
            perDay: LAUNCH_NEW_CONNECTIONS_PER_DAY,
          })}
        </Typography>
        {apps && apps.length > 0 ? (
          <Button
            variant="contained"
            startIcon={<AddOutlined />}
            onClick={openCreate}
            disabled={atAppLimit}
            sx={{ minHeight: 44, flexShrink: 0 }}
          >
            {t('page.register')}
          </Button>
        ) : null}
      </Box>

      {body}

      {formTarget ? (
        <AppFormDialog
          key={formTarget.kind === 'edit' ? formTarget.app.clientId : 'create'}
          app={formTarget.kind === 'edit' ? formTarget.app : null}
          onClose={() => setFormTarget(null)}
          onSubmit={submitForm}
        />
      ) : null}

      {pending?.kind === 'rotate' ? (
        <ConfirmActionDialog
          title={t('rotate.title', { app: pending.app.name })}
          paragraphs={[t('rotate.body')]}
          confirmLabel={t('rotate.confirm')}
          workingLabel={t('rotate.working')}
          destructive={false}
          working={working}
          onConfirm={() => void confirmPending()}
          onClose={() => setPending(null)}
        />
      ) : null}

      {pending?.kind === 'delete' ? (
        <ConfirmActionDialog
          title={t('delete.title', { app: pending.app.name })}
          paragraphs={[
            (pendingApp?.activeConnections ?? 0) > 0
              ? t('delete.connected', { count: pendingApp?.activeConnections ?? 0 })
              : t('delete.noneConnected'),
            t('delete.permanent'),
          ]}
          confirmLabel={t('delete.confirm')}
          workingLabel={t('delete.working')}
          destructive
          working={working}
          onConfirm={() => void confirmPending()}
          onClose={() => setPending(null)}
        />
      ) : null}

      {revealed ? (
        <SecretDialog revealed={revealed} onClose={() => setRevealed(null)} onCopyFailed={onCopyFailed} />
      ) : null}
    </Box>
  );
}
