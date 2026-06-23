'use client';

import React, { useState, useCallback } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Typography from '@mui/material/Typography';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import AddIcon from '@mui/icons-material/Add';
import { useTranslation } from 'react-i18next';
import { themeTokens } from '@/app/theme/theme-config';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { ClientError } from 'graphql-request';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { CREATE_PROPOSAL } from '@boardsesh/graphql/operations/proposals';
import { BOULDER_GRADES, ANGLES } from '@/app/lib/board-data';
import { getGradeTintColor } from '@/app/lib/grade-colors';
import SwipeableDrawer from '@/app/components/swipeable-drawer/swipeable-drawer';
import type { Proposal, ProposalType } from '@boardsesh/shared-schema';
import type { BoardName } from '@/app/lib/types';

type CreateProposalFormProps = {
  climbUuid: string;
  boardType: string;
  angle: number;
  isFrozen?: boolean;
  outlierWarning?: boolean;
  currentClimbDifficulty?: string;
  boardName?: string;
  onCreated?: (proposal: Proposal) => void;
};

export default function CreateProposalForm({
  climbUuid,
  boardType,
  angle,
  isFrozen,
  outlierWarning,
  currentClimbDifficulty,
  boardName,
  onCreated,
}: CreateProposalFormProps) {
  const { t } = useTranslation('common');
  const { token } = useWsAuthToken();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<ProposalType>('grade');
  const [proposedValue, setProposedValue] = useState(currentClimbDifficulty || '');
  const [reason, setReason] = useState('');
  const [selectedAngle, setSelectedAngle] = useState<number | 'all'>(angle);
  const [loading, setLoading] = useState(false);
  const [snackbar, setSnackbar] = useState('');

  const boardAngles = boardName ? ANGLES[boardName as BoardName] || [] : [];

  const handleClose = useCallback(() => {
    setOpen(false);
  }, []);

  const handleTypeChange = useCallback(
    (_: React.MouseEvent, val: ProposalType | null) => {
      if (!val) return;
      setType(val);
      // Reset proposed value when changing type
      if (val === 'grade' || val === 'benchmark') {
        setSelectedAngle(angle);
      } else {
        setSelectedAngle('all');
      }
      if (val === 'grade') {
        setProposedValue(currentClimbDifficulty || '');
      } else {
        setProposedValue('');
      }
    },
    [currentClimbDifficulty, angle],
  );

  const handleSubmit = useCallback(async () => {
    if (!token) {
      setSnackbar(t('proposal.validation.signIn'));
      return;
    }
    if (!proposedValue) {
      setSnackbar(t('proposal.validation.missingValue'));
      return;
    }
    if (type === 'grade' && proposedValue === currentClimbDifficulty) {
      setSnackbar(t('proposal.validation.sameGrade'));
      return;
    }

    setLoading(true);
    try {
      const client = createGraphQLHttpClient(token);
      let proposalAngle: typeof selectedAngle | null;
      if (type === 'classic' || selectedAngle === 'all') {
        proposalAngle = null;
      } else {
        proposalAngle = selectedAngle;
      }
      const result = await client.request<{ createProposal: Proposal }>(CREATE_PROPOSAL, {
        input: {
          climbUuid,
          boardType,
          angle: proposalAngle,
          type,
          proposedValue,
          reason: reason || null,
        },
      });

      if (!result.createProposal) {
        setSnackbar(t('proposal.validation.noData'));
        return;
      }

      onCreated?.(result.createProposal);
      handleClose();
      setProposedValue(type === 'grade' ? currentClimbDifficulty || '' : '');
      setReason('');
      setSnackbar(t('proposal.created'));
    } catch (err) {
      if (err instanceof ClientError) {
        const msg = err.response?.errors?.[0]?.message;
        setSnackbar(msg || t('proposal.validation.failed'));
      } else {
        setSnackbar(err instanceof Error ? err.message : t('proposal.validation.failed'));
      }
    } finally {
      setLoading(false);
    }
  }, [
    token,
    climbUuid,
    boardType,
    selectedAngle,
    type,
    proposedValue,
    reason,
    onCreated,
    handleClose,
    currentClimbDifficulty,
    t,
  ]);

  if (isFrozen) return null;

  const gradeBackground = type === 'grade' && proposedValue ? getGradeTintColor(proposedValue, 'light') : undefined;

  return (
    <>
      <Button
        size="small"
        variant="outlined"
        startIcon={<AddIcon />}
        onClick={() => {
          if (!token) {
            setSnackbar(t('proposal.validation.signIn'));
            return;
          }
          setOpen(true);
        }}
        sx={{
          textTransform: 'none',
          borderColor: themeTokens.neutral[300],
          color: themeTokens.neutral[600],
          fontSize: 13,
        }}
      >
        {t('proposal.trigger')}
      </Button>

      <SwipeableDrawer
        placement="bottom"
        title={t('proposal.drawerTitle')}
        open={open}
        onClose={handleClose}
        footer={
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
            <Button onClick={handleClose} sx={{ textTransform: 'none' }}>
              {t('proposal.cancel')}
            </Button>
            <Button
              onClick={handleSubmit}
              variant="contained"
              disabled={loading || !proposedValue || (type === 'grade' && proposedValue === currentClimbDifficulty)}
              sx={{
                textTransform: 'none',
                bgcolor: 'var(--color-primary-fill)',
                '&:hover': { bgcolor: 'var(--color-primary-fill-hover)' },
              }}
            >
              {loading ? t('proposal.submitting') : t('proposal.submit')}
            </Button>
          </Box>
        }
      >
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {/* Type selector */}
          <ToggleButtonGroup value={type} exclusive onChange={handleTypeChange} size="small" fullWidth>
            <ToggleButton value="grade">{t('proposal.types.grade')}</ToggleButton>
            <ToggleButton value="classic">{t('proposal.types.classic')}</ToggleButton>
            <ToggleButton value="benchmark">{t('proposal.types.benchmark')}</ToggleButton>
          </ToggleButtonGroup>

          {/* Angle selector */}
          {boardAngles.length > 0 && type !== 'classic' && (
            <FormControl size="small" fullWidth>
              <InputLabel>{t('proposal.fields.angle')}</InputLabel>
              <Select
                value={selectedAngle}
                label={t('proposal.fields.angle')}
                onChange={(e) => setSelectedAngle(e.target.value)}
                MenuProps={{ PaperProps: { sx: { maxHeight: 300 } } }}
              >
                {boardAngles.map((a) => (
                  <MenuItem key={a} value={a}>
                    {a}°
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          )}

          {/* Grade dropdown */}
          {type === 'grade' && (
            <FormControl size="small" fullWidth>
              <InputLabel>{t('proposal.fields.proposedGrade')}</InputLabel>
              <Select
                value={proposedValue}
                label={t('proposal.fields.proposedGrade')}
                onChange={(e) => setProposedValue(e.target.value)}
                sx={gradeBackground ? { bgcolor: gradeBackground } : undefined}
                MenuProps={{ PaperProps: { sx: { maxHeight: 300 } } }}
              >
                {BOULDER_GRADES.map((grade) => (
                  <MenuItem key={grade.difficulty_id} value={grade.difficulty_name}>
                    {grade.difficulty_name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          )}

          {/* Classic/Benchmark status selector */}
          {(type === 'classic' || type === 'benchmark') && (
            <>
              <Typography variant="caption" sx={{ color: themeTokens.neutral[500] }}>
                {type === 'classic' ? t('proposal.hints.classic') : t('proposal.hints.benchmark')}
              </Typography>
              <FormControl size="small" fullWidth>
                <InputLabel>{t('proposal.fields.proposedStatus')}</InputLabel>
                <Select
                  value={proposedValue}
                  label={t('proposal.fields.proposedStatus')}
                  onChange={(e) => setProposedValue(e.target.value)}
                >
                  <MenuItem value="true">{t('proposal.fields.yes')}</MenuItem>
                  <MenuItem value="false">{t('proposal.fields.no')}</MenuItem>
                </Select>
              </FormControl>
            </>
          )}

          {/* Reason */}
          <TextField
            label={t('proposal.fields.reasonLabel')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            multiline
            rows={2}
            size="small"
            fullWidth
            placeholder={t('proposal.fields.reasonPlaceholder')}
          />

          {/* Outlier warning */}
          {outlierWarning && type === 'grade' && (
            <Alert severity="info" sx={{ fontSize: 13 }}>
              {t('proposal.outlierWarning')}
            </Alert>
          )}
        </Box>
      </SwipeableDrawer>

      <Snackbar open={!!snackbar} autoHideDuration={3000} onClose={() => setSnackbar('')} message={snackbar} />
    </>
  );
}
