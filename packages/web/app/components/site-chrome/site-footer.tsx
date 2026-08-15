'use client';

import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import CompactLanguageSwitcher from '@/app/components/i18n/compact-language-switcher';
import StartClimbingButton from '@/app/components/start-climbing-button';
import { isChromeLessPath } from '@/app/lib/chrome-less-routes';
import { usePathnameWithoutLocale } from '@/app/lib/i18n/use-locale-router';
import { themeTokens } from '@/app/theme/theme-config';
import styles from './site-footer.module.css';

const FOOTER_START_CLIMBING_SX = {
  borderRadius: `${themeTokens.borderRadius.full}px`,
  textTransform: 'none',
  fontWeight: themeTokens.typography.fontWeight.semibold,
  px: 3,
  backgroundColor: 'var(--color-primary-fill)',
  color: 'var(--color-on-primary)',
  '&:hover': {
    backgroundColor: 'var(--color-primary-fill-hover)',
    transform: 'none',
  },
} as const;

const LINK_SX = {
  color: 'text.secondary',
  textDecorationColor: 'currentcolor',
  '&:hover': { color: 'text.primary' },
} as const;

/**
 * Site-wide footer, rendered in normal flow at the end of every page.
 *
 * It carries the internal links the deleted chrome used to hide behind drawers,
 * so every indexable surface ships crawlable anchors to the rest of the site,
 * and it re-hosts the locale switcher that used to live in the user drawer —
 * without it a four-locale site would have no way to change language.
 */
export default function SiteFooter() {
  const { t } = useTranslation('common');
  const pathname = usePathnameWithoutLocale();

  // Kiosk TVs and iframe embeds render zero chrome.
  if (isChromeLessPath(pathname)) {
    return null;
  }

  const links: { href: string; label: string }[] = [
    { href: '/', label: t('footer.links.home') },
    { href: '/about', label: t('footer.links.about') },
    { href: '/help', label: t('footer.links.help') },
    { href: '/docs', label: t('footer.links.docs') },
    { href: '/playlists', label: t('footer.links.playlists') },
    { href: '/aurora-migration', label: t('footer.links.auroraMigration') },
    { href: '/legal', label: t('footer.links.legal') },
    { href: '/privacy', label: t('footer.links.privacy') },
  ];

  return (
    <Box component="footer" className={styles.footer}>
      <Box className={styles.inner}>
        <Box className={styles.intro}>
          <Typography variant="h6" component="p" sx={{ fontWeight: themeTokens.typography.fontWeight.bold, m: 0 }}>
            {/* i18n-ignore-next-line — brand name, never translated (CLAUDE.md) */}
            Boardsesh
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ maxWidth: '46ch' }}>
            {t('footer.tagline')}
          </Typography>
          <StartClimbingButton
            label={t('header.startClimbing')}
            ariaLabel={t('ariaLabels.startClimbing')}
            size="medium"
            sx={FOOTER_START_CLIMBING_SX}
          />
        </Box>

        <Box component="nav" aria-label={t('footer.navLabel')} className={styles.links}>
          {links.map(({ href, label }) => (
            <MuiLink key={href} component={LocaleLink} href={href} variant="body2" sx={LINK_SX}>
              {label}
            </MuiLink>
          ))}
        </Box>
      </Box>

      <Box className={styles.bottom}>
        <Typography variant="caption" color="text.secondary">
          {t('footer.trademarkNote')}
        </Typography>
        <CompactLanguageSwitcher />
      </Box>
    </Box>
  );
}
