'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Alert from '@mui/material/Alert';
import Typography from '@mui/material/Typography';
import Link from '@mui/material/Link';
import { gymReportingAliasSources, gymReportingAliasTargets, hasGraphqlErrorCode } from '@boardsesh/graphql';
import type { GymStats } from '@boardsesh/shared-schema';

type Props = {
  stats: GymStats;
  saveZone: (zone: string | null) => Promise<void>;
  saveAlias: (boardUuid: string, rootBoardUuid: string | null) => Promise<void>;
};

export function GymReportingSettings({ stats, saveZone, saveAlias }: Props) {
  const { t } = useTranslation('boards');
  const [editingZone, setEditingZone] = useState(false);
  const [zone, setZone] = useState(stats.timeZoneConfigured ? stats.timeZone : '');
  const [sourceUuid, setSourceUuid] = useState('');
  const [targetUuid, setTargetUuid] = useState('');
  const [confirmingAlias, setConfirmingAlias] = useState(false);
  const [pending, setPending] = useState(false);
  const [zoneError, setZoneError] = useState<'invalid' | 'save' | null>(null);
  const [aliasError, setAliasError] = useState(false);
  const sources = gymReportingAliasSources(stats.boards);
  const source = sources.find((board) => board.uuid === sourceUuid);
  const targets = gymReportingAliasTargets(stats.boards, source);
  const target = targets.find((board) => board.uuid === targetUuid);
  const unlink = targetUuid === 'independent' && !!source?.rootUuid;
  const canConfirm = !!source && (unlink || !!target);

  async function updateZone() {
    setPending(true);
    setZoneError(null);
    try {
      await saveZone(zone.trim() || null);
      setEditingZone(false);
    } catch (error) {
      setZoneError(hasGraphqlErrorCode(error, 'INVALID_TIME_ZONE') ? 'invalid' : 'save');
    } finally {
      setPending(false);
    }
  }

  async function updateAlias() {
    if (!source || !canConfirm) return;
    setPending(true);
    setAliasError(false);
    try {
      await saveAlias(source.uuid, target?.uuid ?? null);
      setSourceUuid('');
      setTargetUuid('');
      setConfirmingAlias(false);
    } catch {
      setAliasError(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <Box sx={{ display: 'grid', gap: 2 }}>
      <Link href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer" variant="body2">
        {t('gymReporting.locationAttribution')}
      </Link>
      {editingZone ? (
        <Box
          component="form"
          onSubmit={(event) => {
            event.preventDefault();
            void updateZone();
          }}
          sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'start' }}
        >
          <TextField
            size="small"
            label={t('gymReporting.timeZone')}
            value={zone}
            placeholder={t('gymReporting.zoneExample')}
            helperText={zoneError === 'invalid' ? t('gymReporting.invalidZone') : t('gymReporting.zoneHint')}
            error={zoneError === 'invalid'}
            onChange={(event) => setZone(event.target.value)}
            disabled={pending}
          />
          <Button type="submit" variant="contained" disabled={pending}>
            {t('gymReporting.save')}
          </Button>
          <Button
            onClick={() => {
              setEditingZone(false);
              setZoneError(null);
            }}
            disabled={pending}
          >
            {t('gymReporting.cancel')}
          </Button>
          {zoneError === 'save' && <Alert severity="error">{t('gymReporting.saveError')}</Alert>}
        </Box>
      ) : (
        <Box>
          <Button
            onClick={() => {
              setZone(stats.timeZoneConfigured ? stats.timeZone : '');
              setEditingZone(true);
            }}
          >
            {t('gymReporting.editZone')}
          </Button>
        </Box>
      )}
      {stats.canManageBoardAliases && sources.length > 0 && (
        <Box sx={{ display: 'grid', gap: 1 }}>
          <Typography component="h3" variant="subtitle2">
            {t('gymReporting.groupBoards')}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {t('gymReporting.groupHint')}
          </Typography>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'start' }}>
            <TextField
              select
              size="small"
              label={t('gymReporting.sourceBoard')}
              value={sourceUuid}
              onChange={(event) => {
                setSourceUuid(event.target.value);
                setTargetUuid('');
                setConfirmingAlias(false);
                setAliasError(false);
              }}
              sx={{ minWidth: 180 }}
              disabled={pending}
            >
              <MenuItem value="">{t('gymReporting.chooseBoard')}</MenuItem>
              {sources.map((board) => (
                <MenuItem value={board.uuid} key={board.uuid}>
                  {board.name}
                </MenuItem>
              ))}
            </TextField>
            {!!source && (
              <TextField
                select
                size="small"
                label={t('gymReporting.targetBoard')}
                value={targetUuid}
                onChange={(event) => {
                  setTargetUuid(event.target.value);
                  setConfirmingAlias(false);
                  setAliasError(false);
                }}
                sx={{ minWidth: 180 }}
                disabled={pending}
              >
                <MenuItem value="">{t('gymReporting.chooseBoard')}</MenuItem>
                {source.rootUuid && <MenuItem value="independent">{t('gymReporting.independentBoard')}</MenuItem>}
                {targets.map((board) => (
                  <MenuItem value={board.uuid} key={board.uuid}>
                    {board.name}
                  </MenuItem>
                ))}
              </TextField>
            )}
            {canConfirm && !confirmingAlias && (
              <Button variant="outlined" onClick={() => setConfirmingAlias(true)}>
                {t('gymReporting.reviewGrouping')}
              </Button>
            )}
          </Box>
          {confirmingAlias && source && canConfirm && (
            <Box sx={{ display: 'grid', gap: 1, justifyItems: 'start' }}>
              <Typography variant="body2" role="status">
                {target
                  ? t('gymReporting.confirmGroup', { source: source.name, target: target.name })
                  : t('gymReporting.confirmUngroup', { source: source.name })}
              </Typography>
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                <Button disabled={pending} onClick={() => setConfirmingAlias(false)}>
                  {t('gymReporting.cancel')}
                </Button>
                <Button disabled={pending} variant="contained" onClick={() => void updateAlias()}>
                  {t('gymReporting.confirmGrouping')}
                </Button>
              </Box>
            </Box>
          )}
          {aliasError && <Alert severity="error">{t('gymReporting.groupError')}</Alert>}
        </Box>
      )}
    </Box>
  );
}
