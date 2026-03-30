'use client';

import React from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Avatar from '@mui/material/Avatar';
import AvatarGroup from '@mui/material/AvatarGroup';
import Chip from '@mui/material/Chip';
import LinearProgress from '@mui/material/LinearProgress';
import TimerOutlined from '@mui/icons-material/TimerOutlined';
import FlagOutlined from '@mui/icons-material/FlagOutlined';
import GroupsOutlined from '@mui/icons-material/GroupsOutlined';
import PersonOutlined from '@mui/icons-material/PersonOutlined';
import type { ActivityFeedItem } from '@boardsesh/shared-schema';
import { getGradeColor } from '@/app/lib/grade-colors';
import { useGradeFormat } from '@/app/hooks/use-grade-format';

interface SessionSummaryMetadata {
  totalSends?: number;
  totalAttempts?: number;
  durationMinutes?: number;
  goal?: string;
  gradeDistribution?: Array<{ grade: string; count: number }>;
  participants?: Array<{ userId: string; displayName?: string; avatarUrl?: string }>;
}

interface SessionSummaryFeedItemProps {
  item: ActivityFeedItem;
}

export default function SessionSummaryFeedItem({ item }: SessionSummaryFeedItemProps) {
  const { formatGrade } = useGradeFormat();

  let metadata: SessionSummaryMetadata = {};
  try {
    if (typeof item.metadata === 'string') {
      metadata = JSON.parse(item.metadata) as SessionSummaryMetadata;
    } else if (item.metadata && typeof item.metadata === 'object') {
      metadata = item.metadata as unknown as SessionSummaryMetadata;
    }
  } catch {
    // Ignore parse errors
  }
  const { totalSends = 0, totalAttempts = 0, durationMinutes, goal, gradeDistribution = [], participants = [] } = metadata;

  const maxGradeCount = Math.max(...gradeDistribution.map((g) => g.count), 1);

  const formatDuration = (minutes: number) => {
    if (minutes < 60) return `${minutes}min`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hours}h ${mins}min` : `${hours}h`;
  };

  return (
    <Card data-testid="activity-feed-item">
      <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
        {/* Header */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <GroupsOutlined fontSize="small" color="primary" />
          <Typography variant="body2" fontWeight={600}>
            Session completed
          </Typography>
          {item.actorDisplayName && (
            <Typography variant="body2" color="text.secondary">
              by {item.actorDisplayName}
            </Typography>
          )}
        </Box>

        {/* Goal */}
        {goal && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 1 }}>
            <FlagOutlined sx={{ fontSize: 14 }} color="action" />
            <Typography variant="caption" color="text.secondary">
              {goal}
            </Typography>
          </Box>
        )}

        {/* Stats row */}
        <Box sx={{ display: 'flex', gap: 1, mb: 1, flexWrap: 'wrap', alignItems: 'center' }}>
          <Chip label={`${totalSends} sends`} size="small" color="primary" />
          <Chip label={`${totalAttempts} attempts`} size="small" variant="outlined" />
          {durationMinutes != null && (
            <Chip
              icon={<TimerOutlined />}
              label={formatDuration(durationMinutes)}
              size="small"
              variant="outlined"
            />
          )}
        </Box>

        {/* Mini grade distribution */}
        {gradeDistribution.length > 0 && (
          <Box sx={{ display: 'flex', gap: 0.5, mb: 1, flexWrap: 'wrap' }}>
            {gradeDistribution.slice(0, 6).map((g) => (
              <Box key={g.grade} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <Typography variant="caption" sx={{ fontWeight: 600, minWidth: 24 }}>
                  {formatGrade(g.grade) ?? g.grade}
                </Typography>
                <LinearProgress
                  variant="determinate"
                  value={(g.count / maxGradeCount) * 100}
                  sx={{
                    width: 40,
                    height: 8,
                    borderRadius: 0.5,
                    bgcolor: 'action.hover',
                    '& .MuiLinearProgress-bar': {
                      bgcolor: getGradeColor(g.grade),
                      borderRadius: 0.5,
                    },
                  }}
                />
              </Box>
            ))}
          </Box>
        )}

        {/* Participant avatars */}
        {participants.length > 0 && (
          <AvatarGroup max={5} sx={{ justifyContent: 'flex-start' }}>
            {participants.map((p) => (
              <Avatar
                key={p.userId}
                src={p.avatarUrl ?? undefined}
                sx={{ width: 24, height: 24 }}
              >
                {!p.avatarUrl && <PersonOutlined sx={{ fontSize: 12 }} />}
              </Avatar>
            ))}
          </AvatarGroup>
        )}
      </CardContent>
    </Card>
  );
}
