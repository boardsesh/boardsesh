'use client';

import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Typography from '@mui/material/Typography';
import { visuallyHidden } from '@mui/utils';
import {
  presentGymAngleUsage,
  type GymAngleUsageBoardPresentation,
  type GymAngleUsageRowPresentation,
} from '@boardsesh/graphql';
import type { GymStats } from '@boardsesh/shared-schema';
import { themeTokens } from '@/app/theme/theme-config';

function AngleBar({ row }: { row: GymAngleUsageRowPresentation }) {
  const { t } = useTranslation('boards');
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const climbers = t('gymReporting.climbers', { countText: row.climbers });
  const share = row.isBelowMinimum
    ? t('gymReporting.angleUsage.belowShare', { percentage: row.percentLabel })
    : row.percentLabel;
  const shareText = share ? t('gymReporting.angleUsage.rowShare', { climbers, percentage: share }) : climbers;
  const leaderText = row.isLeader ? t('gymReporting.angleUsage.leading') : null;

  return (
    <Box component="li">
      <ButtonBase
        aria-label={[row.angleLabel, leaderText, shareText].filter(Boolean).join('. ')}
        aria-expanded={expanded}
        aria-controls={detailsId}
        aria-describedby={detailsId}
        onClick={() => setExpanded((open) => !open)}
        sx={{
          width: '100%',
          minHeight: 48,
          display: 'grid',
          gap: 0.5,
          px: 1,
          py: 0.5,
          textAlign: 'start',
          borderRadius: 1,
          '&.Mui-focusVisible': { outline: `2px solid ${themeTokens.colors.primary}`, outlineOffset: 2 },
        }}
      >
        <Box
          component="span"
          sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 0.5 }}
        >
          <Typography component="span" variant="body2" fontWeight={row.isLeader ? 700 : 500}>
            {row.angleLabel}
            {leaderText && (
              <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                {leaderText}
              </Typography>
            )}
          </Typography>
          <Typography component="span" variant="body2" color="text.secondary">
            {shareText}
          </Typography>
        </Box>
        <Box component="span" aria-hidden="true" sx={{ height: 6, borderRadius: 1, bgcolor: themeTokens.neutral[200] }}>
          <Box
            component="span"
            sx={{
              display: 'block',
              width: `${(row.share ?? 0) * 100}%`,
              height: '100%',
              borderRadius: 1,
              bgcolor: row.isLeader ? themeTokens.colors.accent : themeTokens.colors.primary,
            }}
          />
        </Box>
      </ButtonBase>
      <Box id={detailsId} sx={expanded ? { display: 'grid', gap: 0.5, px: 1, pb: 1 } : visuallyHidden}>
        <Typography variant="body2">
          {t('gymReporting.angleUsage.climberDays', { countText: row.climberDays })}
        </Typography>
        <Typography variant="body2">{t('gymReporting.angleUsage.ticks', { countText: row.ticks })}</Typography>
        <Typography variant="body2">{t('gymReporting.sends', { countText: row.sends })}</Typography>
        <Typography variant="body2">{t('gymReporting.angleUsage.displays', { countText: row.displays })}</Typography>
        {row.unresolvedDates !== null && (
          <Typography variant="body2" color="text.secondary">
            {t('gymReporting.angleUsage.unresolvedDates', { countText: row.unresolvedDates })}
          </Typography>
        )}
      </Box>
    </Box>
  );
}

function BoardSummary({ board }: { board: GymAngleUsageBoardPresentation }) {
  const { t } = useTranslation('boards');
  switch (board.summary) {
    case 'empty':
      return t('gymReporting.angleUsage.empty');
    case 'unknownOnly':
      return t('gymReporting.angleUsage.unknownOnly');
    case 'unidentified':
      return t('gymReporting.angleUsage.unidentified');
    case 'single':
      return t('gymReporting.angleUsage.single', { angle: board.leaders, countText: board.leadingClimbers });
    case 'tied':
      return t('gymReporting.angleUsage.tied', { angles: board.leaders, countText: board.leadingClimbers });
    case 'mostUsed':
      return t('gymReporting.angleUsage.mostUsed', { angle: board.leaders, countText: board.leadingClimbers });
  }
}

export function GymAngleUsage({ stats }: { stats: GymStats }) {
  const { t, i18n } = useTranslation('boards');
  const locale = i18n.language || 'en-US';
  const boards = useMemo(() => presentGymAngleUsage(stats, locale), [stats, locale]);
  if (boards.length === 0) return null;

  return (
    <Box component="section" sx={{ display: 'grid', gap: 2 }}>
      <Typography component="h3" variant="h6">
        {t('gymReporting.angleUsage.title')}
      </Typography>
      {boards.map((board) => (
        <Box component="section" key={board.boardUuid} sx={{ display: 'grid', gap: 0.5 }}>
          <Typography component="h4" variant="subtitle1">
            {board.boardName}
          </Typography>
          <Typography variant="body2">
            <BoardSummary board={board} />
          </Typography>
          {board.rows.length > 0 && (
            <>
              <Typography variant="body2" color="text.secondary">
                {t('gymReporting.angleUsage.sample', { countText: board.sample })}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {t('gymReporting.angleUsage.overlap')}
              </Typography>
              <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none' }}>
                {board.rows.map((row) => (
                  <AngleBar row={row} key={row.angle} />
                ))}
              </Box>
            </>
          )}
          {board.unknown && (
            <Box sx={{ px: 1, py: 0.5 }}>
              <Typography variant="subtitle2">{t('gymReporting.angleUsage.unknown')}</Typography>
              <Typography variant="body2">
                {t('gymReporting.angleUsage.ticks', { countText: board.unknown.ticks })}
              </Typography>
              <Typography variant="body2">{t('gymReporting.sends', { countText: board.unknown.sends })}</Typography>
              <Typography variant="body2">
                {t('gymReporting.angleUsage.displays', { countText: board.unknown.displays })}
              </Typography>
            </Box>
          )}
        </Box>
      ))}
    </Box>
  );
}
