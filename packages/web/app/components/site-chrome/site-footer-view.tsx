'use client';

import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import type { SiteFooterLabels } from './site-footer-labels';
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

export default function SiteFooterView({
  labels,
  developerHref: initialDeveloperHref = '/developers',
}: {
  labels: SiteFooterLabels;
  developerHref?: '/developers' | '/docs';
}) {
  const developerHref = useMarketingCapabilities()?.developerHref ?? initialDeveloperHref;
  const { openChoices } = useConsent();
  const pathname = usePathnameWithoutLocale();
  if (isChromeLessPath(pathname)) return null;
  const groups: { id: string; heading: string; links: FooterLink[] }[] = [
    {
      id: 'climb',
      heading: labels.climb,
      links: [
        { href: '/boards', label: labels.supportedBoards, target: '/boards' },
        { href: '/apps', label: labels.appGuides, target: '/apps', locale: 'en-US' },
        { href: '/gyms', label: labels.gyms, target: '/gyms' },
        { href: '/playlists', label: labels.playlists, target: '/playlists' },
        { href: '/bring-your-logbook', label: labels.auroraMigration, target: '/bring-your-logbook' },
      ],
    },
    {
      id: 'walls',
      heading: labels.walls,
      links: [
        { href: '/spraywalls', label: labels.setupSpray, target: '/spraywalls' },
        { href: '/gyms?claim=1', label: labels.claimGym, target: '/gyms' },
        { href: '/for-gyms#partners', label: labels.partners, target: '/for-gyms' },
      ],
    },
    {
      id: 'project',
      heading: labels.project,
      links: [
        { href: '/about', label: labels.about, target: '/about' },
        { href: '/support', label: labels.support, target: '/support' },
        {
          href: 'https://github.com/boardsesh/boardsesh',
          label: labels.source,
          target: 'source',
          external: true,
        },
        {
          href: 'https://github.com/boardsesh/boardsesh/issues',
          label: labels.roadmap,
          target: 'roadmap',
          external: true,
        },
        {
          href: 'https://discord.gg/YXA8GsXfQK',
          label: labels.discord,
          target: 'discord',
          external: true,
        },
        { href: developerHref, label: labels.developers, target: developerHref },
      ],
    },
    {
      id: 'help',
      heading: labels.helpHeading,
      links: [
        { href: '/help', label: labels.helpLink, target: '/help' },
        { href: '/help/board-and-bluetooth', label: labels.bluetooth, target: '/help' },
        {
          href: 'https://github.com/boardsesh/boardsesh/issues/new',
          label: labels.reportBug,
          target: 'report-bug',
          external: true,
        },
        { href: '/legal', label: labels.legal, target: '/legal' },
        { href: '/privacy', label: labels.privacy, target: '/privacy' },
      ],
    },
  ];
  return (
    <Box component="footer" className={styles.footer} data-testid="site-footer">
      <Box className={styles.inner}>
        <Box className={styles.intro}>
          <MuiLink
            component={LocaleLink}
            href="/"
            onClick={(click) => trackWebsiteJourneyLinkClick(click, navLinkClicked('footer', '/'))}
            aria-label={labels.homeAriaLabel}
            underline="none"
            sx={{ display: 'inline-flex', alignItems: 'center', minWidth: 44, minHeight: 44 }}
          >
            <BrandLockup />
          </MuiLink>
          <Typography variant="body2" color="text.secondary">
            {labels.tagline}
          </Typography>
          {!pathname.startsWith('/auth') && (
            <StartClimbingButton
              label={labels.openBrowser}
              ariaLabel={labels.startClimbingAriaLabel}
              placement="footer"
              variant="outlined"
              sx={OPEN_BROWSER_SX}
            />
          )}
        </Box>
        <Box component="nav" aria-label={labels.navLabel} className={styles.links}>
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
                  {labels.privacyChoices}
                </MuiLink>
              )}
            </Box>
          ))}
        </Box>
      </Box>
      <Box className={styles.bottom}>
        <Typography variant="caption" color="text.secondary" sx={{ fontSize: 14, lineHeight: 1.6, maxWidth: '90ch' }}>
          {labels.trademarkNote} {labels.storeTrademarks}{' '}
          <MuiLink component={LocaleLink} href="/legal#trademark-usage" sx={LINK_SX}>
            {labels.legal}
          </MuiLink>
        </Typography>
        <CompactLanguageSwitcher ariaLabel={labels.languageSwitcherAriaLabel} />
      </Box>
    </Box>
  );
}
