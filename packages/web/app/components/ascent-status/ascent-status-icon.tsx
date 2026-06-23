'use client';

import React from 'react';
import CheckOutlined from '@mui/icons-material/CheckOutlined';
import ElectricBoltOutlined from '@mui/icons-material/ElectricBoltOutlined';
import { themeTokens } from '@/app/theme/theme-config';
import { PersonFallingIcon } from '@/app/components/icons/person-falling-icon';
import { normalizeAscentStatus, type AscentStatusValue, type NormalizeAscentStatusInput } from './ascent-status-utils';

type AscentStatusIconProps = {
  variant?: 'icon' | 'badge';
  fontSize?: number;
  className?: string;
  mirrored?: boolean;
  badgeSize?: number;
  testId?: string;
} & NormalizeAscentStatusInput;

const STATUS_CONFIG: Record<
  AscentStatusValue,
  {
    Icon: typeof CheckOutlined;
    iconColor: string;
    badgeBackgroundColor: string;
    badgeIconColor: string;
  }
> = {
  flash: {
    Icon: ElectricBoltOutlined,
    iconColor: themeTokens.colors.amber,
    badgeBackgroundColor: themeTokens.colors.amber,
    badgeIconColor: themeTokens.neutral[900],
  },
  send: {
    Icon: CheckOutlined,
    iconColor: 'var(--color-success)',
    badgeBackgroundColor: 'var(--color-success)',
    badgeIconColor: 'white',
  },
  attempt: {
    Icon: PersonFallingIcon,
    iconColor: 'var(--color-error)',
    badgeBackgroundColor: 'var(--color-error)',
    badgeIconColor: 'white',
  },
};

export function AscentStatusIcon({
  status,
  isAscent,
  tries,
  variant = 'icon',
  fontSize = themeTokens.typography.fontSize.base,
  className,
  mirrored = false,
  badgeSize,
  testId,
}: AscentStatusIconProps) {
  const resolvedStatus = normalizeAscentStatus({ status, isAscent, tries });
  const { Icon, iconColor, badgeBackgroundColor, badgeIconColor } = STATUS_CONFIG[resolvedStatus];
  const iconStyle: React.CSSProperties = {
    color: variant === 'badge' ? badgeIconColor : iconColor,
    fontSize,
    transform: mirrored ? 'scaleX(-1)' : undefined,
  };

  if (variant === 'icon') {
    return (
      <Icon
        className={className}
        style={iconStyle}
        aria-hidden="true"
        data-status={resolvedStatus}
        data-testid={testId}
      />
    );
  }

  const fallbackBadgeSize = typeof fontSize === 'number' ? fontSize + 8 : themeTokens.spacing[5];
  const resolvedBadgeSize = badgeSize ?? (className ? undefined : fallbackBadgeSize);

  return (
    <span
      className={className}
      style={{
        backgroundColor: badgeBackgroundColor,
        borderRadius: '50%',
        color: badgeIconColor,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        lineHeight: 0,
        width: resolvedBadgeSize,
        height: resolvedBadgeSize,
      }}
      aria-hidden="true"
      data-status={resolvedStatus}
      data-testid={testId}
    >
      <Icon style={iconStyle} />
    </span>
  );
}
