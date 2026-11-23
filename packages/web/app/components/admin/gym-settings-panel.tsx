'use client';

import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Paper from '@mui/material/Paper';
import Switch from '@mui/material/Switch';
import FormControlLabel from '@mui/material/FormControlLabel';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
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
const DAILY_CAP_KEY = 'gym_claim_auto_approve_daily_cap';

/**
 * The cap the backend applies while the setting is unset
 * (`DEFAULT_GYM_CLAIM_AUTO_APPROVE_DAILY_CAP` in
 * packages/backend/src/graphql/resolvers/social/community-settings.ts).
 */
const DEFAULT_DAILY_CAP = 10;
const MAX_DAILY_CAP = 1000;

/**
 * The cap the backend applies for a stored value, read its way
 * (`gymClaimAutoApproveDailyCap`): any whole number, a negative one as 0, and
 * anything else as the default. Shown as is, so the field never claims a limit
 * the backend isn't using.
 */
function appliedDailyCap(stored: string | undefined): number {
  const trimmed = (stored ?? '').trim();
  if (!/^-?\d+$/.test(trimmed)) return DEFAULT_DAILY_CAP;
  return Math.max(0, Number.parseInt(trimmed, 10));
}

/** What the admin may save: a whole number from 0 to {@link MAX_DAILY_CAP}, or null. */
function parseCapDraft(draft: string): number | null {
  const trimmed = draft.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const cap = Number.parseInt(trimmed, 10);
  return cap <= MAX_DAILY_CAP ? cap : null;
}

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
  const storedCap = settingsQuery.data?.find((setting) => setting.key === DAILY_CAP_KEY)?.value;
  const storedBase = storedCap ?? null;
  const savedCap = appliedDailyCap(storedCap);
  // What the admin typed, against the stored text it was typed over: a new
  // stored value (theirs, or another admin's) puts the field back in step.
  const [capDraft, setCapDraft] = useState<{ base: string | null; text: string } | null>(null);
  const activeDraft = capDraft !== null && capDraft.base === storedBase ? capDraft : null;
  const capText = activeDraft ? activeDraft.text : String(savedCap);
  // Only what the admin types is held to 0 to 1000; a stored value is shown as the backend reads it.
  const draftValue = activeDraft ? parseCapDraft(activeDraft.text) : null;
  const draftInvalid = activeDraft !== null && draftValue === null;
  // Against the stored text, not the cap read from it, so a value the backend
  // reads as the default (unset, or not a number) can still be saved as one.
  const canSaveCap = draftValue !== null && String(draftValue) !== storedCap;

  const setDailyCap = useMutation({
    mutationFn: async (next: number) => {
      if (!token) throw new Error('Not authenticated');
      const client = createGraphQLHttpClient(token);
      await client.request(SET_COMMUNITY_SETTING, {
        input: { scope: SCOPE, scopeKey: SCOPE_KEY, key: DAILY_CAP_KEY, value: String(next) },
      });
      return next;
    },
    onError: () => setSnackbar(t('gymSettings.snackbar.saveFailed')),
    onSuccess: () => setSnackbar(t('gymSettings.dailyCap.saved')),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: settingsQueryKey });
    },
  });

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

        {/* The guard that bounds the switch above: past it, claims wait for review. */}
        <Box
          component="form"
          onSubmit={(event: React.FormEvent) => {
            event.preventDefault();
            if (canSaveCap && draftValue !== null) setDailyCap.mutate(draftValue);
          }}
          sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, flexWrap: 'wrap', mt: 2.5 }}
        >
          <TextField
            label={t('gymSettings.dailyCap.label')}
            type="number"
            size="small"
            value={capText}
            onChange={(event) => setCapDraft({ base: storedBase, text: event.target.value })}
            disabled={!token || !settingsQuery.isSuccess || setDailyCap.isPending}
            error={draftInvalid}
            helperText={draftInvalid ? t('gymSettings.dailyCap.invalid') : undefined}
            slotProps={{ htmlInput: { min: 0, max: MAX_DAILY_CAP, step: 1, inputMode: 'numeric' } }}
            sx={{ width: 160 }}
          />
          <Button
            type="submit"
            variant="outlined"
            disabled={!token || !settingsQuery.isSuccess || !canSaveCap || setDailyCap.isPending}
            sx={{ textTransform: 'none', minHeight: 40 }}
          >
            {t('gymSettings.dailyCap.save')}
          </Button>
        </Box>
        <Typography variant="caption" component="p" sx={{ color: themeTokens.neutral[500], mt: 0.5 }}>
          {t('gymSettings.dailyCap.description')}
        </Typography>
      </Paper>

      <Snackbar open={!!snackbar} autoHideDuration={3000} onClose={() => setSnackbar('')} message={snackbar} />
    </Box>
  );
}
