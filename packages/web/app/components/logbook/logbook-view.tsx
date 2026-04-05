'use client';

import React from 'react';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Chip from '@mui/material/Chip';
import Rating from '@mui/material/Rating';
import { EmptyState } from '@/app/components/ui/empty-state';
import CheckOutlined from '@mui/icons-material/CheckOutlined';
import CloseOutlined from '@mui/icons-material/CloseOutlined';
import { Climb } from '@/app/lib/types';
import { useBoardProvider } from '../board-provider/board-provider-context';
import { useAscentActions } from '@/app/components/ascent-actions/use-ascent-actions';
import AscentActionsMenu from '@/app/components/ascent-actions/ascent-actions-menu';
import { themeTokens } from '@/app/theme/theme-config';
import dayjs from 'dayjs';

interface LogbookViewProps {
  currentClimb: Climb;
}

export const LogbookView: React.FC<LogbookViewProps> = ({ currentClimb }) => {
  const { logbook, boardName, isAuthenticated } = useBoardProvider();
  const { handleUpdate, handleDelete, isUpdating, isDeleting } = useAscentActions(boardName);

  // Filter ascents for current climb and sort by climbed_at
  const climbAscents = logbook
    .filter((ascent) => ascent.climb_uuid === currentClimb.uuid)
    .sort((a, b) => {
      const dateA = dayjs(a.climbed_at);
      const dateB = dayjs(b.climbed_at);
      return dateB.valueOf() - dateA.valueOf();
    });

  const showMirrorTag = boardName === 'tension';

  if (climbAscents.length === 0) {
    return <EmptyState description="No ascents logged for this climb" />;
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {climbAscents.map((ascent) => (
        <Card key={`${ascent.climb_uuid}-${ascent.climbed_at}`} sx={{ width: '100%' }}>
          <CardContent sx={{ p: 1.5 }}>
            <Stack spacing={1} style={{ width: '100%' }}>
              <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                <Typography variant="body2" component="span" fontWeight={600} sx={{ flex: 1 }}>
                  {dayjs(ascent.climbed_at).format('MMM D, YYYY h:mm A')}
                </Typography>
                {ascent.angle !== currentClimb.angle && (
                  <>
                    <Chip label={ascent.angle} size="small" color="primary" />
                    {ascent.is_ascent ? (
                      <CheckOutlined style={{ color: themeTokens.colors.success }} />
                    ) : (
                      <CloseOutlined style={{ color: themeTokens.colors.error }} />
                    )}
                  </>
                )}
                {showMirrorTag && ascent.is_mirror && <Chip label="Mirrored" size="small" color="secondary" />}
                {isAuthenticated && ascent.status && (
                  <AscentActionsMenu
                    ascent={{
                      uuid: ascent.uuid,
                      status: ascent.status,
                      attemptCount: ascent.tries,
                      quality: ascent.quality,
                      comment: ascent.comment,
                    }}
                    onUpdate={handleUpdate}
                    onDelete={handleDelete}
                    updating={isUpdating}
                    deleting={isDeleting}
                  />
                )}
              </Stack>
              {ascent.is_ascent && ascent.quality && (
                <Stack direction="row" spacing={1}>
                  <Rating readOnly value={ascent.quality} max={5} size="small" />
                </Stack>
              )}
              <Stack direction="row" spacing={1}>
                <Typography variant="body2" component="span">Attempts: {ascent.tries}</Typography>
              </Stack>

              {ascent.comment && (
                <Typography variant="body2" component="span" color="text.secondary" sx={{ whiteSpace: 'pre-wrap' }}>
                  {ascent.comment}
                </Typography>
              )}
            </Stack>
          </CardContent>
        </Card>
      ))}
    </Box>
  );
};
