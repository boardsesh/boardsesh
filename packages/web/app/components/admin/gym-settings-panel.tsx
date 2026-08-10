'use client';

import React, { useState, useEffect, useCallback } from 'react';
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

export default function GymSettingsPanel() {
  const { t } = useTranslation('admin');
  const { token } = useWsAuthToken();
  const [autoApprove, setAutoApprove] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [snackbar, setSnackbar] = useState('');

  // Deliberately depends on `token` alone. Pulling `t` in here would re-run the
  // effect on every render that hands back a fresh `t`, and each run re-fetches.
  // Load failure is a flag; the copy for it is resolved in the JSX below.
  const fetchSettings = useCallback(async () => {
    if (!token) return;
    try {
      const client = createGraphQLHttpClient(token);
      const result = await client.request<{ communitySettings: CommunitySettingType[] }>(GET_COMMUNITY_SETTINGS, {
        scope: SCOPE,
        scopeKey: SCOPE_KEY,
      });
      const saved = result.communitySettings.find((setting) => setting.key === AUTO_APPROVE_KEY)?.value;
      setAutoApprove(saved === '1' || saved === 'true');
      setLoadFailed(false);
      setLoaded(true);
    } catch (err) {
      console.error('[GymSettings] Failed to fetch:', err);
      setLoadFailed(true);
    }
  }, [token]);

  useEffect(() => {
    void fetchSettings();
  }, [fetchSettings]);

  const handleToggle = useCallback(
    async (next: boolean) => {
      if (!token) return;
      // Optimistic: flip immediately, roll back if the write is rejected.
      setAutoApprove(next);
      setSaving(true);
      try {
        const client = createGraphQLHttpClient(token);
        await client.request(SET_COMMUNITY_SETTING, {
          input: { scope: SCOPE, scopeKey: SCOPE_KEY, key: AUTO_APPROVE_KEY, value: next ? '1' : '0' },
        });
        setSnackbar(next ? t('gymSettings.snackbar.enabled') : t('gymSettings.snackbar.disabled'));
      } catch {
        setAutoApprove(!next);
        setSnackbar(t('gymSettings.snackbar.saveFailed'));
      } finally {
        setSaving(false);
      }
    },
    [token, t],
  );

  return (
    <Box>
      <Typography variant="h6" sx={{ fontWeight: 600, mb: 2 }}>
        {t('gymSettings.heading')}
      </Typography>

      {loadFailed && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {t('gymSettings.snackbar.loadFailed')}
        </Alert>
      )}

      <Paper variant="outlined" sx={{ p: 2 }}>
        <FormControlLabel
          control={
            <Switch
              checked={autoApprove}
              disabled={!loaded || saving}
              onChange={(event) => void handleToggle(event.target.checked)}
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
