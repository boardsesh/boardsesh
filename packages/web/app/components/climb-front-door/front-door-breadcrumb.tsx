import React from 'react';
import Box from '@mui/material/Box';
import LocaleLink from '@/app/components/i18n/locale-link';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { themeTokens } from '@/app/theme/theme-config';

type FrontDoorBreadcrumbProps = {
  boardName: string;
  angle: number;
  /** Canonical `/list` URL for this board config at this angle. */
  boardListUrl: string;
  /** The leaf. Rendered as plain text, not a self-link. */
  currentLabel: string;
};

const listSx = {
  display: 'flex',
  flexWrap: 'wrap' as const,
  alignItems: 'center',
  gap: 1,
  listStyle: 'none',
  margin: 0,
  padding: `${themeTokens.spacing[2]}px 0`,
  fontSize: themeTokens.typography.fontSize.sm,
  color: 'var(--neutral-400)',
};

const separatorSx = { color: 'var(--neutral-400)' };

/**
 * Home → board list → this climb. Two of the front door's internal links, and
 * the hierarchy signal for `BreadcrumbList`-shaped crawling.
 */
export default async function FrontDoorBreadcrumb({
  boardName,
  angle,
  boardListUrl,
  currentLabel,
}: FrontDoorBreadcrumbProps) {
  const { t } = await getServerTranslation('climbs');

  return (
    <Box component="nav" aria-label={t('frontDoor.breadcrumb.aria')}>
      <Box component="ol" sx={listSx}>
        <li>
          <LocaleLink href="/">{t('frontDoor.breadcrumb.home')}</LocaleLink>
        </li>
        <Box component="li" aria-hidden sx={separatorSx}>
          /
        </Box>
        <li>
          <LocaleLink href={boardListUrl}>
            {t('frontDoor.breadcrumb.board', { boardName })} — {t('frontDoor.breadcrumb.list', { angle })}
          </LocaleLink>
        </li>
        <Box component="li" aria-hidden sx={separatorSx}>
          /
        </Box>
        <Box component="li" aria-current="page">
          {currentLabel}
        </Box>
      </Box>
    </Box>
  );
}
