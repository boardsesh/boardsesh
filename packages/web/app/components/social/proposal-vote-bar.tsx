'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import LinearProgress from '@mui/material/LinearProgress';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { themeTokens } from '@/app/theme/theme-config';

type ProposalVoteBarProps = {
  weightedUpvotes: number;
  weightedDownvotes: number;
  requiredUpvotes: number;
  status: string;
};

export default function ProposalVoteBar({
  weightedUpvotes,
  weightedDownvotes,
  requiredUpvotes,
  status,
}: ProposalVoteBarProps) {
  const { t } = useTranslation('feed');
  const progress = requiredUpvotes > 0 ? Math.min((weightedUpvotes / requiredUpvotes) * 100, 100) : 0;
  const isApproved = status === 'approved';
  const isRejected = status === 'rejected';

  if (isApproved) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Chip
          icon={<CheckCircleIcon />}
          label={t('proposalVoteBar.approved')}
          size="small"
          sx={{
            bgcolor: 'var(--color-success-bg)',
            color: 'var(--color-success)',
            fontWeight: 600,
            '& .MuiChip-icon': { color: 'var(--color-success)' },
          }}
        />
      </Box>
    );
  }

  if (isRejected) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Chip
          label={t('proposalVoteBar.rejected')}
          size="small"
          sx={{
            bgcolor: 'var(--color-error-bg)',
            color: 'var(--color-error)',
            fontWeight: 600,
          }}
        />
      </Box>
    );
  }

  return (
    <Box sx={{ width: '100%' }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.5 }}>
        <Typography variant="caption" sx={{ color: themeTokens.neutral[500] }}>
          {t('proposalVoteBar.votesNeeded', { current: weightedUpvotes, required: requiredUpvotes })}
        </Typography>
        {weightedDownvotes > 0 && (
          <Typography variant="caption" sx={{ color: 'var(--color-error)' }}>
            {t('proposalVoteBar.opposed', { count: weightedDownvotes })}
          </Typography>
        )}
      </Box>
      <LinearProgress
        variant="determinate"
        value={progress}
        sx={{
          height: 6,
          borderRadius: 3,
          bgcolor: themeTokens.neutral[200],
          '& .MuiLinearProgress-bar': {
            borderRadius: 3,
            bgcolor: progress >= 100 ? 'var(--color-success)' : 'var(--color-primary-fill)',
          },
        }}
      />
    </Box>
  );
}
