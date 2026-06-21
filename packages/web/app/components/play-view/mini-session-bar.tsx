'use client';

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import AvatarGroup from '@mui/material/AvatarGroup';
import type { SessionUser } from '@boardsesh/shared-schema';
import { themeTokens } from '@/app/theme/theme-config';
import { TickBadgeAvatar } from '@/app/components/session/tick-badge-avatar';
import type { ClimbQueueItem } from '../queue-control/types';

export type MiniSessionBarProps = {
  /** Active party session. Solo / no-session → bar hides. */
  isPersistentSessionActive: boolean;
  /** Full session-user list. The bar excludes the local user. */
  sessionUsers: SessionUser[];
  /** Local user's session participantId; used to exclude self from the
   *  audience. */
  participantId: string | null;
  /** The wall climb (what's currently lit). The audience tick badges reflect
   *  who has done this climb. */
  currentClimbQueueItem: ClimbQueueItem | null;
};

/**
 * Mini session bar that sits between the board renderer and the action bar
 * inside the play-view drawer. Always-live model: it surfaces the session
 * audience (everyone but the local user) with tick badges for who has done the
 * current climb. There is no driver role, so no role-specific morph.
 *
 * Solo / no party: returns null.
 */
export function MiniSessionBar({
  isPersistentSessionActive,
  sessionUsers,
  participantId,
  currentClimbQueueItem,
}: MiniSessionBarProps) {
  const { t } = useTranslation('session');

  const tickedBySet = useMemo(() => new Set(currentClimbQueueItem?.tickedBy ?? []), [currentClimbQueueItem]);

  const audienceUsers = useMemo(() => {
    if (!isPersistentSessionActive) return [];
    return sessionUsers.filter((user) => user.id !== participantId);
  }, [isPersistentSessionActive, sessionUsers, participantId]);

  if (!isPersistentSessionActive || currentClimbQueueItem == null || audienceUsers.length === 0) return null;

  return (
    <Box
      data-testid="mini-session-bar"
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 2,
        py: 0.75,
        borderTop: '1px solid var(--neutral-200)',
        // Warm whisper tint — gives the band a reason to exist visually without
        // painting it like an alert. ~5% theme warning so it sits between the
        // neutral climb area above and the neutral action bar below.
        backgroundColor: `color-mix(in srgb, ${themeTokens.colors.warning} 5%, transparent)`,
        minHeight: 36,
      }}
    >
      <Box
        component="span"
        sx={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: 0.5,
          color: 'text.secondary',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0,
        }}
      >
        {t('playView.audienceCount', { count: audienceUsers.length })}
      </Box>
      <Box data-testid="mini-session-bar-audience" sx={{ ml: 'auto', flexShrink: 0 }}>
        <AvatarGroup
          max={3}
          sx={{
            '& .MuiAvatar-root': {
              width: 22,
              height: 22,
              fontSize: 10,
              border: '2px solid transparent',
            },
          }}
        >
          {audienceUsers.map((user) => (
            <TickBadgeAvatar
              key={user.id}
              user={user}
              hasTicked={tickedBySet.has(user.id) || (user.userId != null && tickedBySet.has(user.userId))}
              size={22}
            />
          ))}
        </AvatarGroup>
      </Box>
    </Box>
  );
}
