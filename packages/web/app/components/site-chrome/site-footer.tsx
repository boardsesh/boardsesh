'use client';

import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import { useTranslation } from 'react-i18next';
import { SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import { boardTypeLabel } from '@boardsesh/board-constants/board-type-labels';
import { navLinkClicked, type WebsiteNavTarget } from '@boardsesh/analytics';
import { trackWebsiteJourneyEvent, trackWebsiteJourneyLinkClick } from '@/app/lib/website-journey-analytics';
import { useConsent } from '../consent/consent-state-provider';
import LocaleLink from '@/app/components/i18n/locale-link';
import CompactLanguageSwitcher from '@/app/components/i18n/compact-language-switcher';
import StartClimbingButton from '@/app/components/start-climbing-button';
import { brandCtaOutlinedSx } from '@/app/components/ui/brand-cta';
import { isChromeLessPath } from '@/app/lib/chrome-less-routes';
import { usePathnameWithoutLocale } from '@/app/lib/i18n/use-locale-router';
import BrandLockup from './brand-lockup';
import styles from './site-footer.module.css';
import { useMarketingCapabilities } from '../marketing/marketing-capabilities-context';

// Column links are grey (#B0B0B0), lifting to the label ink with an underline on
// hover or focus. The violet stays with inline links and the page's one CTA.
const LINK_SX = {
  color: 'text.secondary',
  textDecoration: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  minWidth: 44,
  minHeight: 44,
  fontSize: 14,
  lineHeight: 1.5,
  '&:hover, &:focus-visible': { color: 'text.primary', textDecoration: 'underline' },
} as const;
// "Open it in your browser": the shared grey outlined pill, the same secondary
// action as the hero's second store button.
const OPEN_BROWSER_SX = brandCtaOutlinedSx({ size: 'medium' });
type FooterLink = { href: string; label: string; target: WebsiteNavTarget; external?: boolean; locale?: 'en-US' };

export default function SiteFooter({
  developerHref: initialDeveloperHref = '/developers',
}: {
  developerHref?: '/developers' | '/docs';
}) {
  const developerHref = useMarketingCapabilities()?.developerHref ?? initialDeveloperHref;
  const { t } = useTranslation('common');
  const { t: consentTranslation } = useTranslation('consent');
  const { openChoices } = useConsent();
  const pathname = usePathnameWithoutLocale();
  if (isChromeLessPath(pathname)) return null;
  const groups: { id: string; heading: string; links: FooterLink[] }[] = [
    {
      id: 'climb',
      heading: t('footer.journeys.climb'),
      links: [
        { href: '/boards', label: t('footer.journeys.supportedBoards'), target: '/boards' },
        { href: '/apps', label: t('footer.journeys.appGuides'), target: '/apps', locale: 'en-US' },
        { href: '/gyms', label: t('footer.links.gyms'), target: '/gyms' },
        { href: '/playlists', label: t('footer.links.playlists'), target: '/playlists' },
        { href: '/bring-your-logbook', label: t('footer.links.auroraMigration'), target: '/bring-your-logbook' },
      ],
    },
    {
      id: 'walls',
      heading: t('footer.journeys.walls'),
      links: [
        { href: '/spraywalls', label: t('footer.journeys.setupSpray'), target: '/spraywalls' },
        { href: '/gyms?claim=1', label: t('footer.journeys.claimGym'), target: '/gyms' },
        { href: '/for-gyms#partners', label: t('footer.journeys.partners'), target: '/for-gyms' },
      ],
    },
    {
      id: 'project',
      heading: t('footer.journeys.project'),
      links: [
        { href: '/about', label: t('footer.links.about'), target: '/about' },
        { href: '/support', label: t('footer.links.support'), target: '/support' },
        {
          href: 'https://github.com/boardsesh/boardsesh',
          label: t('footer.journeys.source'),
          target: 'source',
          external: true,
        },
        {
          href: 'https://github.com/boardsesh/boardsesh/issues',
          label: t('footer.journeys.roadmap'),
          target: 'roadmap',
          external: true,
        },
        {
          href: 'https://discord.gg/YXA8GsXfQK',
          label: t('footer.journeys.discord'),
          target: 'discord',
          external: true,
        },
        { href: developerHref, label: t('footer.journeys.developers'), target: developerHref },
      ],
    },
    {
      id: 'help',
      heading: t('footer.journeys.help'),
      links: [
        { href: '/help', label: t('footer.links.help'), target: '/help' },
        { href: '/help/board-and-bluetooth', label: t('footer.journeys.bluetooth'), target: '/help' },
        {
          href: 'https://github.com/boardsesh/boardsesh/issues/new',
          label: t('footer.journeys.reportBug'),
          target: 'report-bug',
          external: true,
        },
        { href: '/legal', label: t('footer.links.legal'), target: '/legal' },
        { href: '/privacy', label: t('footer.links.privacy'), target: '/privacy' },
      ],
    },
  ];
  const boards = SUPPORTED_BOARDS.filter((board) => board !== 'spray')
    .map(boardTypeLabel)
    .join(', ');
  return (
    <Box component="footer" className={styles.footer} data-testid="site-footer">
      <Box className={styles.inner}>
        <Box className={styles.intro}>
          <MuiLink
            component={LocaleLink}
            href="/"
            onClick={(click) => trackWebsiteJourneyLinkClick(click, navLinkClicked('footer', '/'))}
            aria-label={t('ariaLabels.home')}
            underline="none"
            sx={{ display: 'inline-flex', alignItems: 'center', minWidth: 44, minHeight: 44 }}
          >
            <BrandLockup />
          </MuiLink>
          <Typography variant="body2" color="text.secondary">
            {t('footer.tagline')}
          </Typography>
          {!pathname.startsWith('/auth') && (
            <StartClimbingButton
              label={t('footer.openBrowser')}
              ariaLabel={t('ariaLabels.startClimbing')}
              placement="footer"
              variant="outlined"
              sx={OPEN_BROWSER_SX}
            />
          )}
        </Box>
        <Box component="nav" aria-label={t('footer.navLabel')} className={styles.links}>
          {groups.map((group) => (
            <Box key={group.id} className={styles.linkGroup}>
              <Typography component="h2" variant="subtitle2" sx={{ fontWeight: 600 }}>
                {group.heading}
              </Typography>
              {group.links.map((link) => (
                <MuiLink
                  key={link.href}
                  component={link.external ? 'a' : LocaleLink}
                  href={link.href}
                  locale={link.locale}
                  target={link.external ? '_blank' : undefined}
                  rel={link.external ? 'noopener noreferrer' : undefined}
                  sx={LINK_SX}
                  onClick={(click) => trackWebsiteJourneyLinkClick(click, navLinkClicked('footer', link.target))}
                >
                  {link.label}
                </MuiLink>
              ))}
              {group.id === 'help' && (
                <MuiLink
                  component="button"
                  type="button"
                  sx={LINK_SX}
                  onClick={() => {
                    trackWebsiteJourneyEvent(navLinkClicked('footer', 'privacy-choices'));
                    openChoices();
                  }}
                >
                  {consentTranslation('privacyChoices')}
                </MuiLink>
              )}
            </Box>
          ))}
        </Box>
      </Box>
      <Box className={styles.bottom}>
        <Typography variant="caption" color="text.secondary" sx={{ fontSize: 14, lineHeight: 1.6, maxWidth: '90ch' }}>
          {t('footer.trademarkNote', { boards })} {t('footer.storeTrademarks')}{' '}
          <MuiLink component={LocaleLink} href="/legal#trademark-usage" sx={LINK_SX}>
            {t('footer.links.legal')}
          </MuiLink>
        </Typography>
        <CompactLanguageSwitcher />
      </Box>
    </Box>
  );
}
