'use client';

import React from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Avatar from '@mui/material/Avatar';
import AvatarGroup from '@mui/material/AvatarGroup';
import Chip from '@mui/material/Chip';
import TimerOutlined from '@mui/icons-material/TimerOutlined';
import FlagOutlined from '@mui/icons-material/FlagOutlined';
import FlashOnOutlined from '@mui/icons-material/FlashOnOutlined';
import CheckCircleOutlineOutlined from '@mui/icons-material/CheckCircleOutlineOutlined';
import ErrorOutlineOutlined from '@mui/icons-material/ErrorOutlineOutlined';
import PersonOutlined from '@mui/icons-material/PersonOutlined';
import Link from 'next/link';
import type { SessionFeedItem } from '@boardsesh/shared-schema';
import { CssBarChart } from '@/app/components/charts/css-bar-chart';
import { buildSessionGradeBars } from '@/app/components/charts/session-grade-bars';
import OutcomeDoughnut from '@/app/components/charts/outcome-doughnut';
import VoteButton from '@/app/components/social/vote-button';
import FeedCommentButton from '@/app/components/social/feed-comment-button';
import { themeTokens } from '@/app/theme/theme-config';
import { getGradeColor, getGradeTextColor, formatVGrade } from '@/app/lib/grade-colors';

interface SessionFeedCardProps {
  session: SessionFeedItem;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function generateSessionName(firstTickAt: string, boardTypes: string[]): string {
  const day = DAYS[new Date(firstTickAt).getDay()];
  const boards = boardTypes
    .map((bt) => bt.charAt(0).toUpperCase() + bt.slice(1))
    .join(' & ');
  return `${day} ${boards} Session`;
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}min` : `${hours}h`;
}

function formatRelativeTime(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diff = now - then;

  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  return new Date(isoString).toLocaleDateString();
}

export default function SessionFeedCard({ session }: SessionFeedCardProps) {
  const {
    sessionId,
    sessionName,
    participants,
    totalSends,
    totalFlashes,
    totalAttempts,
    tickCount,
    gradeDistribution,
    boardTypes,
    hardestGrade,
    firstTickAt,
    lastTickAt,
    durationMinutes,
    goal,
    upvotes,
    downvotes,
    commentCount,
  } = session;

  const primaryParticipant = participants[0] ?? null;
  const isMultiUser = participants.length > 1;

  const displayName = sessionName || generateSessionName(firstTickAt, boardTypes);

  const hardestGradeColor = getGradeColor(hardestGrade);
  const hardestGradeTextColor = getGradeTextColor(hardestGradeColor);

  const gradeBars = React.useMemo(
    () => buildSessionGradeBars(gradeDistribution),
    [gradeDistribution],
  );

  return (
    <Card
      data-testid="activity-feed-item"
      sx={{
        transition: `box-shadow ${themeTokens.transitions.normal}`,
        '&:hover': {
          boxShadow: themeTokens.shadows.md,
        },
      }}
    >
      <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
        {/* Header: Avatar(s) + name(s) + time + duration */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          {isMultiUser ? (
            <AvatarGroup max={3} sx={{ '& .MuiAvatar-root': { width: 28, height: 28, fontSize: 12 } }}>
              {participants.map((p) => (
                <Avatar
                  key={p.userId}
                  src={p.avatarUrl ?? undefined}
                  component="a"
                  href={`/crusher/${p.userId}`}
                  onClick={(e: React.MouseEvent) => e.stopPropagation()}
                  sx={{ width: 28, height: 28, cursor: 'pointer' }}
                >
                  {!p.avatarUrl && <PersonOutlined sx={{ fontSize: 14 }} />}
                </Avatar>
              ))}
            </AvatarGroup>
          ) : (
            <Avatar
              src={primaryParticipant?.avatarUrl ?? undefined}
              {...(primaryParticipant ? { component: 'a', href: `/crusher/${primaryParticipant.userId}` } : {})}
              onClick={(e: React.MouseEvent) => e.stopPropagation()}
              sx={{ width: 32, height: 32, cursor: primaryParticipant ? 'pointer' : 'default' }}
            >
              {!primaryParticipant?.avatarUrl && <PersonOutlined sx={{ fontSize: 16 }} />}
            </Avatar>
          )}

          <Box sx={{ minWidth: 0 }}>
            <Typography
              variant="body2"
              fontWeight={600}
              noWrap
              {...(primaryParticipant ? { component: 'a', href: `/crusher/${primaryParticipant.userId}` } : {})}
              onClick={(e: React.MouseEvent) => e.stopPropagation()}
              sx={{ textDecoration: 'none', color: 'text.primary', cursor: primaryParticipant ? 'pointer' : 'default' }}
            >
              {isMultiUser
                ? participants.map((p) => p.displayName || 'Climber').join(', ')
                : primaryParticipant?.displayName || 'Climber'}
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Typography variant="caption" color="text.secondary">
                {formatRelativeTime(lastTickAt)}
              </Typography>
              {durationMinutes != null && durationMinutes > 0 && (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25 }}>
                  <TimerOutlined sx={{ fontSize: 12, color: 'text.secondary' }} />
                  <Typography variant="caption" color="text.secondary">
                    {formatDuration(durationMinutes)}
                  </Typography>
                </Box>
              )}
            </Box>
          </Box>

          {/* Session title — prominent, right-aligned */}
          <Typography
            variant="subtitle2"
            fontWeight={600}
            noWrap
            sx={{ ml: 'auto', flexShrink: 1, minWidth: 0, textAlign: 'right' }}
          >
            {displayName}
          </Typography>
        </Box>

        {/* Clickable body that links to session detail */}
        <Box
          component={Link}
          href={`/session/${sessionId}`}
          sx={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
        >
          {/* Goal */}
          {goal && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 1 }}>
              <FlagOutlined sx={{ fontSize: 14 }} color="action" />
              <Typography variant="caption" color="text.secondary" noWrap>
                {goal}
              </Typography>
            </Box>
          )}

          {/* Stats row */}
          <Box sx={{ display: 'flex', gap: 0.5, mb: 1, flexWrap: 'wrap', alignItems: 'center' }}>
            {totalFlashes > 0 && (
              <Chip
                icon={<FlashOnOutlined />}
                label={`${totalFlashes} flash${totalFlashes !== 1 ? 'es' : ''}`}
                size="small"
                sx={{
                  borderRadius: themeTokens.borderRadius.full,
                  bgcolor: themeTokens.colors.amber,
                  color: '#000',
                  '& .MuiChip-icon': { color: 'inherit' },
                }}
              />
            )}
            <Chip
              icon={<CheckCircleOutlineOutlined />}
              label={`${totalSends} send${totalSends !== 1 ? 's' : ''}`}
              size="small"
              sx={{
                borderRadius: themeTokens.borderRadius.full,
                bgcolor: themeTokens.colors.successBg,
                color: themeTokens.colors.success,
                '& .MuiChip-icon': { color: 'inherit' },
              }}
            />
            {totalAttempts > 0 && (
              <Chip
                icon={<ErrorOutlineOutlined />}
                label={`${totalAttempts} attempt${totalAttempts !== 1 ? 's' : ''}`}
                size="small"
                sx={{
                  borderRadius: themeTokens.borderRadius.full,
                  bgcolor: 'var(--neutral-50)',
                }}
              />
            )}
            {hardestGrade && (
              <Chip
                label={formatVGrade(hardestGrade) ?? hardestGrade}
                size="small"
                sx={{
                  borderRadius: themeTokens.borderRadius.full,
                  bgcolor: hardestGradeColor || 'var(--neutral-200)',
                  color: hardestGradeTextColor,
                  fontWeight: 600,
                }}
              />
            )}
          </Box>

          {/* Grade chart (compact) + outcome doughnut on desktop */}
          {gradeDistribution.length > 0 && (
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'column',
                mb: 1,
                '@media (min-width: 768px)': {
                  flexDirection: 'row',
                  alignItems: 'stretch',
                  gap: 1,
                },
              }}
            >
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <CssBarChart
                  bars={gradeBars}
                  height={80}
                  mobileHeight={60}
                  showLegend={false}
                  gap={2}
                  ariaLabel="Session grade distribution"
                />
              </Box>
              <Box
                sx={{
                  display: 'none',
                  '@media (min-width: 768px)': {
                    display: 'block',
                    flex: '0 0 120px',
                  },
                }}
              >
                <OutcomeDoughnut
                  flashes={totalFlashes}
                  sends={totalSends}
                  attempts={totalAttempts}
                  height={100}
                  compact
                />
              </Box>
            </Box>
          )}

          {/* Board types + climb count */}
          {boardTypes.length > 0 && (
            <Box sx={{ display: 'flex', gap: 0.5, mb: 1, alignItems: 'center' }}>
              <Typography variant="caption" color="text.secondary">
                {boardTypes.map((bt) => bt.charAt(0).toUpperCase() + bt.slice(1)).join(', ')}
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>
                {tickCount} climb{tickCount !== 1 ? 's' : ''}
              </Typography>
            </Box>
          )}
        </Box>
      </CardContent>

      {/* Social row */}
      <Box sx={{ display: 'flex', alignItems: 'center', px: 1.5, pb: 1, gap: 1 }}>
        <VoteButton
          entityType="session"
          entityId={sessionId}
          initialUpvotes={upvotes}
          initialDownvotes={downvotes}
          likeOnly
        />
        <FeedCommentButton
          entityType="session"
          entityId={sessionId}
          commentCount={commentCount}
        />
      </Box>
    </Card>
  );
}
