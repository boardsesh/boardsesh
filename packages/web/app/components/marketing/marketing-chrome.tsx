import React from 'react';
import Box from '@mui/material/Box';
import { navLinkClicked } from '@boardsesh/analytics';
import BrandLockup from '@/app/components/site-chrome/brand-lockup';
import SiteFooter from '@/app/components/site-chrome/site-footer';
import MarketingConsentBanner from './marketing-consent-banner';
import MarketingPhoneInstall from './marketing-phone-install';
import MarketingDisclosure from './marketing-disclosure';
import StartClimbingButton from '@/app/components/start-climbing-button';
import { WebsiteJourneyLink } from './website-journey-link';
import MarketingAccountControls from './marketing-account-controls';
import { getServerTranslationForLocale } from '@/app/lib/i18n/server';
import { localeHref } from '@/app/lib/i18n/locale-href';
import type { Locale } from '@/app/lib/i18n/config';
import { brandCtaOutlinedSx } from '@/app/components/ui/brand-cta';
import styles from '@/app/components/site-chrome/marketing-header.module.css';

/** Public navigation has no playlist, profile, snackbar or query dependencies. */
export default async function MarketingChrome({
  children,
  locale,
  developerHref,
}: {
  children: React.ReactNode;
  locale: Locale;
  developerHref: '/developers' | '/docs';
}) {
  const { t } = await getServerTranslationForLocale(locale, 'common');
  const links = [
    { href: '/boards', label: t('header.nav.boards') },
    { href: '/gyms', label: t('header.nav.gyms') },
    { href: '/spraywalls', label: t('header.nav.spray') },
    { href: '/playlists', label: t('header.nav.playlists') },
    { href: '/help', label: t('header.nav.help') },
  ] as const;
  const accountLabels = {
    signIn: t('header.signIn'),
    profile: t('ariaLabels.yourProfile'),
    settings: t('ariaLabels.settings'),
  };
  return (
    <>
      <Box component="header" className={styles.header} data-testid="marketing-header">
        <WebsiteJourneyLink
          href={localeHref('/', locale)}
          event={navLinkClicked('header', '/')}
          aria-label={t('ariaLabels.home')}
          color="inherit"
          underline="none"
        >
          <BrandLockup eager />
        </WebsiteJourneyLink>
        <Box component="nav" aria-label={t('header.navLabel')} className={styles.nav}>
          {links.map(({ href, label }) => (
            <WebsiteJourneyLink
              key={href}
              href={localeHref(href, locale)}
              event={navLinkClicked('header', href)}
              color="text.secondary"
              underline="hover"
            >
              {label}
            </WebsiteJourneyLink>
          ))}
        </Box>
        <Box sx={{ flex: 1 }} />
        <Box className={styles.accountSlot}>
          <MarketingAccountControls labels={accountLabels} />
        </Box>
        <MarketingPhoneInstall label={t('header.getApp')} />
        <Box className={styles.desktopAppLink}>
          <StartClimbingButton
            label={t('header.startClimbing')}
            ariaLabel={t('ariaLabels.startClimbing')}
            size="small"
            placement="header"
            variant="outlined"
            sx={brandCtaOutlinedSx({ size: 'small' })}
          />
        </Box>
        <MarketingDisclosure label={t('header.navLabel')}>
          <MarketingAccountControls labels={accountLabels} placement="header-menu" />
          {links.map(({ href, label }) => (
            <WebsiteJourneyLink
              key={href}
              href={localeHref(href, locale)}
              event={navLinkClicked('header-menu', href)}
              color="text.primary"
              underline="hover"
            >
              {label}
            </WebsiteJourneyLink>
          ))}
          <StartClimbingButton
            label={t('header.startClimbing')}
            ariaLabel={t('ariaLabels.startClimbing')}
            placement="header-menu"
            variant="text"
          />
        </MarketingDisclosure>
      </Box>
      {children}
      <SiteFooter developerHref={developerHref} />
      <MarketingConsentBanner />
    </>
  );
}
