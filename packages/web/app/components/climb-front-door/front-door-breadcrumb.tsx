import React from 'react';
import Box from '@mui/material/Box';
import MuiLink from '@mui/material/Link';
import LocaleLink from '@/app/components/i18n/locale-link';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { absoluteUrl } from '@/app/lib/seo/base-url';
import { JsonLd } from '@/app/lib/seo/json-ld';
import { themeTokens } from '@/app/theme/theme-config';

type FrontDoorBreadcrumbProps = {
  boardName: string;
  angle: number;
  /** Canonical `/list` URL for this board config at this angle. */
  boardListUrl: string;
  /**
   * The climb crumb: its label and its own canonical path (the JSON-LD leaf's
   * `item`). Rendered as plain text, not a self-link.
   *
   * Omitted on the `/list` front door, where the board crumb IS the current
   * page — a third crumb there would name a climb the reader is not on.
   */
  leaf?: { label: string; url: string };
  /** Alternate-angle and noindex pages keep visible crumbs but omit schema data. */
  emitJsonLd?: boolean;
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

const currentCrumbSx = { color: 'text.primary', fontWeight: themeTokens.typography.fontWeight.medium };

/**
 * Home → board list → this climb, or Home → board list on the `/list` page
 * itself. The front door's upward links, and the hierarchy signal for
 * `BreadcrumbList`-shaped crawling.
 */
export default async function FrontDoorBreadcrumb({
  boardName,
  angle,
  boardListUrl,
  leaf,
  emitJsonLd = true,
}: FrontDoorBreadcrumbProps) {
  const { t } = await getServerTranslation('climbs');

  const boardCrumbLabel = `${t('frontDoor.breadcrumb.board', { boardName })} — ${t('frontDoor.breadcrumb.list', { angle })}`;
  // Absolute and locale-free, matching the canonical the page claims: the
  // hreflang cluster carries the translations, so a `/es` render must not
  // point its BreadcrumbList at `/es/...` URLs the canonical disowns.
  const breadcrumbJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: t('frontDoor.breadcrumb.home'), item: absoluteUrl('/') },
      { '@type': 'ListItem', position: 2, name: boardCrumbLabel, item: absoluteUrl(boardListUrl) },
      ...(leaf ? [{ '@type': 'ListItem', position: 3, name: leaf.label, item: absoluteUrl(leaf.url) }] : []),
    ],
  };

  return (
    <Box component="nav" aria-label={t('frontDoor.breadcrumb.aria')}>
      {emitJsonLd ? <JsonLd data={breadcrumbJsonLd} /> : null}
      <Box component="ol" sx={listSx}>
        <li>
          <MuiLink component={LocaleLink} href="/" underline="hover" color="inherit">
            {t('frontDoor.breadcrumb.home')}
          </MuiLink>
        </li>
        <Box component="li" aria-hidden sx={separatorSx}>
          /
        </Box>
        {leaf ? (
          <>
            <li>
              <MuiLink component={LocaleLink} href={boardListUrl} underline="hover" color="inherit">
                {boardCrumbLabel}
              </MuiLink>
            </li>
            <Box component="li" aria-hidden sx={separatorSx}>
              /
            </Box>
            <Box component="li" aria-current="page" sx={currentCrumbSx}>
              {leaf.label}
            </Box>
          </>
        ) : (
          <Box component="li" aria-current="page" sx={currentCrumbSx}>
            {boardCrumbLabel}
          </Box>
        )}
      </Box>
    </Box>
  );
}
