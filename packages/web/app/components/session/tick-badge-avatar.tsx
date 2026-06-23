'use client';

import React from 'react';
import Avatar from '@mui/material/Avatar';
import Badge from '@mui/material/Badge';
import CheckOutlined from '@mui/icons-material/CheckOutlined';

const TICK_BADGE_SX = {
  '& .MuiBadge-badge': {
    backgroundColor: 'var(--color-success)',
    color: 'common.white',
    width: 16,
    height: 16,
    minWidth: 16,
    borderRadius: '50%',
    border: '2px solid transparent',
  },
} as const;

export type TickBadgeAvatarProps = {
  user: { id: string; username: string; avatarUrl?: string };
  hasTicked: boolean;
  size?: number;
};

/** Avatar with an optional tick (bottom-right) badge. Shared between the
 *  queue-control bar's session header and the play-view drawer's mini session
 *  bar so the audience treatment is identical across surfaces. */
export function TickBadgeAvatar({ user, hasTicked, size = 28 }: TickBadgeAvatarProps) {
  const baseAvatar = (
    <Avatar
      alt={user.username}
      src={user.avatarUrl ?? undefined}
      sx={size !== 28 ? { width: size, height: size } : undefined}
    />
  );
  if (!hasTicked) return baseAvatar;
  return (
    <Badge
      overlap="circular"
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      badgeContent={<CheckOutlined sx={{ fontSize: 10 }} />}
      sx={TICK_BADGE_SX}
    >
      {baseAvatar}
    </Badge>
  );
}
