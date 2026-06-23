'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Paper from '@mui/material/Paper';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Snackbar from '@mui/material/Snackbar';
import SaveIcon from '@mui/icons-material/Save';
import { useTranslation } from 'react-i18next';
import { themeTokens } from '@/app/theme/theme-config';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { GET_COMMUNITY_SETTINGS, SET_COMMUNITY_SETTING } from '@boardsesh/graphql/operations/proposals';
import type { CommunitySettingType } from '@boardsesh/shared-schema';

const SETTING_DEFINITIONS = [
  { key: 'approval_threshold', i18nKey: 'approvalThreshold', defaultValue: '5' },
  { key: 'outlier_min_ascents', i18nKey: 'outlierMinAscents', defaultValue: '10' },
  { key: 'outlier_grade_diff', i18nKey: 'outlierGradeDiff', defaultValue: '2' },
  { key: 'admin_vote_weight', i18nKey: 'adminVoteWeight', defaultValue: '3' },
  { key: 'leader_vote_weight', i18nKey: 'leaderVoteWeight', defaultValue: '2' },
] as const;

export default function CommunitySettingsPanel() {
  const { t } = useTranslation('admin');
  const { token } = useWsAuthToken();
  const [scope, setScope] = useState('global');
  const [scopeKey, setScopeKey] = useState('');
  const [settings, setSettings] = useState<CommunitySettingType[]>([]);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [snackbar, setSnackbar] = useState('');

  const definitions = useMemo(
    () =>
      SETTING_DEFINITIONS.map((def) => ({
        key: def.key,
        label: t(`settings.rows.${def.i18nKey}.label`),
        description: t(`settings.rows.${def.i18nKey}.description`),
        defaultValue: def.defaultValue,
      })),
    [t],
  );

  const fetchSettings = useCallback(async () => {
    if (!token) return;
    try {
      const client = createGraphQLHttpClient(token);
      const result = await client.request<{ communitySettings: CommunitySettingType[] }>(GET_COMMUNITY_SETTINGS, {
        scope,
        scopeKey: scope === 'global' ? '' : scopeKey,
      });
      setSettings(result.communitySettings);
      const values: Record<string, string> = {};
      for (const s of result.communitySettings) {
        values[s.key] = s.value;
      }
      setEditValues(values);
    } catch (err) {
      console.error('[Settings] Failed to fetch:', err);
    }
  }, [token, scope, scopeKey]);

  useEffect(() => {
    if (scope === 'global' || scopeKey) {
      void fetchSettings();
    }
  }, [fetchSettings, scope, scopeKey]);

  const hasChanges = definitions.some((def) => {
    const savedValue = settings.find((s) => s.key === def.key)?.value;
    const editValue = editValues[def.key];
    // Changed if there's an edit value that differs from the saved value (or from empty if no saved value)
    return editValue !== undefined && editValue !== '' && editValue !== (savedValue ?? '');
  });

  const handleSaveAll = useCallback(async () => {
    if (!token) return;
    setSaving(true);
    try {
      const client = createGraphQLHttpClient(token);
      const promises = definitions
        .filter((def) => {
          const savedValue = settings.find((s) => s.key === def.key)?.value;
          const editValue = editValues[def.key];
          return editValue !== undefined && editValue !== '' && editValue !== (savedValue ?? '');
        })
        .map((def) =>
          client.request(SET_COMMUNITY_SETTING, {
            input: {
              scope,
              scopeKey: scope === 'global' ? '' : scopeKey,
              key: def.key,
              value: editValues[def.key],
            },
          }),
        );
      await Promise.all(promises);
      setSnackbar(t('settings.snackbar.saved', { count: promises.length }));
      void fetchSettings();
    } catch {
      setSnackbar(t('settings.snackbar.saveFailed'));
    } finally {
      setSaving(false);
    }
  }, [token, scope, scopeKey, editValues, settings, fetchSettings, definitions, t]);

  return (
    <Box>
      <Typography variant="h6" sx={{ fontWeight: 600, mb: 2 }}>
        {t('settings.heading')}
      </Typography>

      {/* Scope selector */}
      <Box sx={{ display: 'flex', gap: 2, mb: 3 }}>
        <FormControl size="small" sx={{ minWidth: 120 }}>
          <InputLabel>{t('settings.scope.label')}</InputLabel>
          <Select
            value={scope}
            label={t('settings.scope.label')}
            onChange={(e) => {
              setScope(e.target.value);
              setScopeKey('');
            }}
          >
            <MenuItem value="global">{t('settings.scope.options.global')}</MenuItem>
            <MenuItem value="board">{t('settings.scope.options.board')}</MenuItem>
            <MenuItem value="climb">{t('settings.scope.options.climb')}</MenuItem>
          </Select>
        </FormControl>
        {scope !== 'global' && (
          <TextField
            label={scope === 'board' ? t('settings.scope.boardTypeLabel') : t('settings.scope.climbUuidLabel')}
            value={scopeKey}
            onChange={(e) => setScopeKey(e.target.value)}
            size="small"
            sx={{ flex: 1 }}
            placeholder={
              scope === 'board' ? t('settings.scope.boardTypePlaceholder') : t('settings.scope.climbUuidPlaceholder')
            }
          />
        )}
      </Box>

      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>{t('settings.table.setting')}</TableCell>
              <TableCell>{t('settings.table.description')}</TableCell>
              <TableCell>{t('settings.table.value')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {definitions.map((def) => (
              <TableRow key={def.key}>
                <TableCell>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {def.label}
                  </Typography>
                </TableCell>
                <TableCell>
                  <Typography variant="caption" sx={{ color: themeTokens.neutral[500] }}>
                    {def.description}
                  </Typography>
                </TableCell>
                <TableCell>
                  <TextField
                    value={editValues[def.key] || ''}
                    onChange={(e) => setEditValues((prev) => ({ ...prev, [def.key]: e.target.value }))}
                    size="small"
                    sx={{ width: 100 }}
                    placeholder={def.defaultValue}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 2 }}>
        <Button
          variant="contained"
          startIcon={<SaveIcon />}
          onClick={handleSaveAll}
          disabled={!hasChanges || saving}
          sx={{
            textTransform: 'none',
            bgcolor: 'var(--color-primary-fill)',
            '&:hover': { bgcolor: 'var(--color-primary-fill-hover)' },
          }}
        >
          {saving ? t('settings.saving') : t('settings.save')}
        </Button>
      </Box>

      <Snackbar open={!!snackbar} autoHideDuration={3000} onClose={() => setSnackbar('')} message={snackbar} />
    </Box>
  );
}
