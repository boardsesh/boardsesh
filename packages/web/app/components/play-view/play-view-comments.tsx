'use client';

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import Rating from '@mui/material/Rating';
import ChatBubbleOutlineOutlined from '@mui/icons-material/ChatBubbleOutlineOutlined';
import { useBoardProvider } from '../board-provider/board-provider-context';
import { themeTokens } from '@/app/theme/theme-config';
import { formatTickAbsoluteTime, tickTimeMs } from '@/app/lib/format-tick-time';
import { AscentStatusIcon } from '@/app/components/ascent-status/ascent-status-icon';
import { normalizeAscentStatus, type AscentStatusValue } from '@/app/components/ascent-status/ascent-status-utils';

function useAscentChipLabel() {
  const { t } = useTranslation('profile');
  return (status: AscentStatusValue): string => {
    if (status === 'flash') return t('logbook.feed.status.flash');
    if (status === 'send') return t('logbook.feed.status.send');
    return t('logbook.feed.status.attempt');
  };
}

type PlayViewCommentsProps = {
  climbUuid: string | undefined;
};

const PlayViewComments: React.FC<PlayViewCommentsProps> = ({ climbUuid }) => {
  const { t } = useTranslation('session');
  const getAscentChipLabel = useAscentChipLabel();
  const { logbook } = useBoardProvider();

  const ascents = useMemo(
    () =>
      logbook
        .filter((entry) => entry.climb_uuid === climbUuid)
        .sort((a, b) => tickTimeMs(b.climbed_at) - tickTimeMs(a.climbed_at)),
    [logbook, climbUuid],
  );

  if (!climbUuid || ascents.length === 0) return null;

  return (
    <Box sx={{ px: `${themeTokens.spacing[3]}px`, pb: `${themeTokens.spacing[2]}px` }}>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          mb: `${themeTokens.spacing[1]}px`,
          fontWeight: themeTokens.typography.fontWeight.semibold,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          fontSize: themeTokens.typography.fontSize.xs,
        }}
      >
        <ChatBubbleOutlineOutlined sx={{ fontSize: themeTokens.typography.fontSize.sm }} />
        {t('playView.yourAscents', { count: ascents.length })}
      </Typography>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: `${themeTokens.spacing[1]}px` }}>
        {ascents.map((ascent) => {
          const ascentStatus = normalizeAscentStatus({
            status: ascent.status,
            isAscent: ascent.is_ascent,
            tries: ascent.tries,
          });
          const hasSuccess = ascentStatus !== 'attempt';

          return (
            <Box
              key={`${ascent.climb_uuid}-${ascent.climbed_at}`}
              sx={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: `${themeTokens.spacing[2]}px`,
                py: `${themeTokens.spacing[1]}px`,
                borderBottom: '1px solid var(--neutral-100)',
                '&:last-child': { borderBottom: 'none' },
              }}
            >
              <Box sx={{ pt: '2px', flexShrink: 0 }}>
                <AscentStatusIcon
                  status={ascentStatus}
                  variant="icon"
                  fontSize={themeTokens.typography.fontSize.base}
                />
              </Box>

              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ fontSize: themeTokens.typography.fontSize.xs }}
                  >
                    {formatTickAbsoluteTime(ascent.climbed_at, 'MMM D, YYYY')}
                  </Typography>
                  <Chip
                    label={getAscentChipLabel(ascentStatus)}
                    size="small"
                    sx={{
                      height: themeTokens.spacing[5],
                      fontSize: themeTokens.typography.fontSize.xs,
                      bgcolor: hasSuccess ? 'var(--color-success-bg)' : 'var(--neutral-100)',
                      color: hasSuccess ? 'var(--color-success)' : 'var(--neutral-500)',
                    }}
                  />
                  {ascent.tries > 1 && (
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ fontSize: themeTokens.typography.fontSize.xs }}
                    >
                      {t('playView.triesCount', { count: ascent.tries })}
                    </Typography>
                  )}
                </Box>
                {hasSuccess && ascent.quality != null && ascent.quality > 0 && (
                  <Rating
                    readOnly
                    value={ascent.quality}
                    max={5}
                    size="small"
                    sx={{ mt: 0.25, fontSize: themeTokens.typography.fontSize.xs }}
                  />
                )}
                {ascent.comment && (
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{
                      mt: 0.25,
                      fontSize: themeTokens.typography.fontSize.xs,
                      whiteSpace: 'pre-wrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                    }}
                  >
                    {ascent.comment}
                  </Typography>
                )}
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
};

export default PlayViewComments;
