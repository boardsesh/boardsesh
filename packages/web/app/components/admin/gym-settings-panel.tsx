'use client';

import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Paper from '@mui/material/Paper';
import Switch from '@mui/material/Switch';
import FormControlLabel from '@mui/material/FormControlLabel';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import { useTranslation } from 'react-i18next';
import { themeTokens } from '@/app/theme/theme-config';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { GET_COMMUNITY_SETTINGS, SET_COMMUNITY_SETTING } from '@boardsesh/graphql/operations/proposals';
import type { CommunitySettingType } from '@boardsesh/shared-schema';

// Gym settings are global-only — a gym claim isn't scoped to a board type or a
// climb, so there's no scope selector here (unlike the community settings panel).
const SCOPE = 'global';
const SCOPE_KEY = '';

const AUTO_APPROVE_KEY = 'gym_claim_auto_approve';

const settingsQueryKey = ['communitySettings', SCOPE, SCOPE_KEY] as const;

// Stands in for the server-assigned id on an optimistic first write. Never sent
// anywhere and never read — the refetch replaces the row.
const OPTIMISTIC_ROW_ID = -1;

const isOn = (value: string | undefined) => value === '1' || value === 'true';

export default function GymSettingsPanel() {
  const { t } = useTranslation('admin');
  const { token } = useWsAuthToken();
  const queryClient = useQueryClient();
  const [snackbar, setSnackbar] = useState('');

  const settingsQuery = useQuery({
    queryKey: settingsQueryKey,
    enabled: !!token,
    queryFn: async () => {
      const client = createGraphQLHttpClient(token!);
      const result = await client.request<{ communitySettings: CommunitySettingType[] }>(GET_COMMUNITY_SETTINGS, {
        scope: SCOPE,
        scopeKey: SCOPE_KEY,
      });
      return result.communitySettings;
    },
  });

  const autoApprove = isOn(settingsQuery.data?.find((setting) => setting.key === AUTO_APPROVE_KEY)?.value);

  const setAutoApprove = useMutation({
    mutationFn: async (next: boolean) => {
      // The query is gated on `enabled: !!token`, but a mutation has no such
      // gate — a toggle fired after the session expired would otherwise hand a
      // null token to the client. Fail loudly into the error path instead.
      if (!token) throw new Error('Not authenticated');
      const client = createGraphQLHttpClient(token);
      await client.request(SET_COMMUNITY_SETTING, {
        input: { scope: SCOPE, scopeKey: SCOPE_KEY, key: AUTO_APPROVE_KEY, value: next ? '1' : '0' },
      });
      return next;
    },
    // Optimistic flip with a snapshot rollback: React Query restores the
    // previous cache on error, so a rejected write (e.g. a community leader
    // hitting the admin-only gate) can't leave the switch showing a value the
    // server never stored.
    onMutate: async (next: boolean) => {
      await queryClient.cancelQueries({ queryKey: settingsQueryKey });
      const previous = queryClient.getQueryData<CommunitySettingType[]>(settingsQueryKey);
      queryClient.setQueryData<CommunitySettingType[]>(settingsQueryKey, (current) => {
        const rows = current ?? [];
        const value = next ? '1' : '0';
        if (rows.some((setting) => setting.key === AUTO_APPROVE_KEY)) {
          return rows.map((setting) => (setting.key === AUTO_APPROVE_KEY ? { ...setting, value } : setting));
        }
        // First-ever write: no row exists server-side yet. Build a complete
        // placeholder rather than casting a partial one — only `key` and
        // `value` are read here, and `onSettled`'s refetch replaces the whole
        // row with the persisted one moments later.
        const placeholder: CommunitySettingType = {
          id: OPTIMISTIC_ROW_ID,
          scope: SCOPE,
          scopeKey: SCOPE_KEY,
          key: AUTO_APPROVE_KEY,
          value,
          setBy: null,
          createdAt: '',
          updatedAt: '',
        };
        return [...rows, placeholder];
      });
      return { previous };
    },
    onError: (_error, _next, context) => {
      queryClient.setQueryData(settingsQueryKey, context?.previous);
      setSnackbar(t('gymSettings.snackbar.saveFailed'));
    },
    onSuccess: (next) => {
      setSnackbar(next ? t('gymSettings.snackbar.enabled') : t('gymSettings.snackbar.disabled'));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: settingsQueryKey });
    },
  });

  return (
    <Box>
      <Typography variant="h6" sx={{ fontWeight: 600, mb: 2 }}>
        {t('gymSettings.heading')}
      </Typography>

      {settingsQuery.isError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {t('gymSettings.snackbar.loadFailed')}
        </Alert>
      )}

      <Paper variant="outlined" sx={{ p: 2 }}>
        <FormControlLabel
          control={
            <Switch
              checked={autoApprove}
              // Never let a failed or in-flight read look like "off" — an admin
              // shouldn't act on a value we haven't actually received.
              disabled={!token || !settingsQuery.isSuccess || setAutoApprove.isPending}
              onChange={(event) => setAutoApprove.mutate(event.target.checked)}
            />
          }
          label={
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {t('gymSettings.autoApprove.label')}
            </Typography>
          }
        />
        <Typography variant="caption" component="p" sx={{ color: themeTokens.neutral[500], mt: 0.5 }}>
          {t('gymSettings.autoApprove.description')}
        </Typography>
        <Typography variant="caption" component="p" sx={{ color: themeTokens.neutral[500], mt: 1 }}>
          {t('gymSettings.autoApprove.queueNote')}
        </Typography>
      </Paper>

      <Snackbar open={!!snackbar} autoHideDuration={3000} onClose={() => setSnackbar('')} message={snackbar} />
    </Box>
  );
}
