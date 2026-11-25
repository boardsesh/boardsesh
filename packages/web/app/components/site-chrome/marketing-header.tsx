'use client';

import { navLinkClicked, webAppOpened, type WebsiteNavTarget } from '@boardsesh/analytics';
import { trackWebsiteJourneyEvent, trackWebsiteJourneyLinkClick } from '@/app/lib/website-journey-analytics';
import React, { useCallback, useRef, useState, type RefObject } from 'react';
import { useInstallPlatform } from '@/app/hooks/use-install-platform';
import { useInboundCampaign } from '@/app/hooks/use-inbound-campaign';
import { useStoreBadgeOnScreen } from '@/app/hooks/use-store-badge-on-screen';
import { resolveHeroInstall } from '@/app/lib/hero-install';
import { buildStoreUrl } from '@/app/lib/store-links';
import { trackAppInstallClick } from '@/app/lib/track-app-install-click';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Button from '@mui/material/Button';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import SettingsOutlined from '@mui/icons-material/SettingsOutlined';
import IosShareOutlined from '@mui/icons-material/IosShare';
import MenuOutlined from '@mui/icons-material/Menu';
import PersonOutlined from '@mui/icons-material/PersonOutlined';
import TuneOutlined from '@mui/icons-material/TuneOutlined';
import { useSession } from 'next-auth/react';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import BackButton from '@/app/components/back-button';
import StartClimbingButton from '@/app/components/start-climbing-button';
import { shareWithFallback } from '@/app/lib/share-utils';
import { isChromeLessPath } from '@/app/lib/chrome-less-routes';
import { usePathnameWithoutLocale } from '@/app/lib/i18n/use-locale-router';
import { useStatsFilterBridge } from '@/app/components/stats-filter-bridge/stats-filter-bridge-context';
import { useProfileHeaderShare } from '@/app/components/profile-header-bridge/profile-header-bridge-context';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { themeTokens } from '@/app/theme/theme-config';
import { brandCtaOutlinedSx } from '@/app/components/ui/brand-cta';
import { APP_URL } from '@/app/lib/app-origin';
import BrandLockup from './brand-lockup';
import styles from './marketing-header.module.css';

// The grey outlined pill for the persistent "Start climbing" hand-off to the
// Expo-web app (and the phone's store button): a secondary action, so it leaves
// the page's violet to the page.
const HEADER_START_CLIMBING_SX = brandCtaOutlinedSx({ size: 'small' });

const BRAND_SX = {
  flexShrink: 0,
  textTransform: 'none',
  fontWeight: themeTokens.typography.fontWeight.bold,
  fontSize: themeTokens.typography.fontSize.lg,
  color: 'var(--bs-text-brand-primary)',
  minWidth: 0,
  px: 0,
  '&:hover': { backgroundColor: 'transparent' },
} as const;

// Nav links are grey (#B0B0B0), lifting to the label ink with an underline on
// hover. The current page adds a 2px violet underline in the module CSS.
const NAV_LINK_SX = {
  color: 'var(--bs-text-brand-muted)',
  fontWeight: themeTokens.typography.fontWeight.medium,
  textDecoration: 'none',
  whiteSpace: 'nowrap',
  '&:hover': { color: 'var(--bs-text-brand-primary)', textDecoration: 'underline' },
} as const;

const SIGN_IN_SX = { textTransform: 'none', flexShrink: 0, color: 'var(--neutral-900)' } as const;

/** Route prefixes that render a simple title header instead of the default marketing header */

function isNavigationActive(pathname: string, destination: string) {
  return (
    pathname === destination ||
    pathname.startsWith(`${destination}/`) ||
    (destination === '/gyms' && pathname.startsWith('/gym/'))
  );
}

type CenteredHeaderProps = {
  left?: React.ReactNode;
  title: string;
  right?: React.ReactNode;
};

type ProfileHeaderConfig = {
  userId: string;
  title: string;
  backUrl: string;
  isRoot: boolean;
};

function CenteredHeader({ left, title, right }: CenteredHeaderProps) {
  return (
    <header className={styles.header} data-testid="marketing-header">
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'minmax(48px, 1fr) auto minmax(48px, 1fr)',
          columnGap: 1.5,
          alignItems: 'center',
          width: '100%',
          minWidth: 0,
          flex: '1 1 auto',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', justifySelf: 'start', minWidth: 0 }}>{left}</Box>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: 0,
            pointerEvents: 'none',
          }}
        >
          <Typography
            variant="h6"
            component="h1"
            sx={{
              margin: 0,
              maxWidth: 'min(60vw, 320px)',
              textAlign: 'center',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {title}
          </Typography>
        </Box>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            justifySelf: 'end',
            minWidth: 0,
          }}
        >
          {right}
        </Box>
      </Box>
    </header>
  );
}

/**
 * The phone's "Get the app" link in the header (shown below 600px only).
 *
 * It steps aside while one of the page's own store badges is on screen: most
 * www pages show a badge right below the header, and the same link twice is one
 * too many (a badge can't go up here instead: Apple allows one App Store badge
 * per layout). It comes back once the badge has scrolled up under the header,
 * and a page with no badge keeps it all along.
 *
 * `data-store-badge-on-screen` carries the answer (`yes`/`no`). Until the hook
 * has one (the server HTML, hydration, the first observer report) the attribute
 * is absent and the module CSS guesses with `:has()`: a badge anywhere in
 * `<main>` hides the link. So the home page never shows the link and then takes
 * it away; a page whose only badge is far down gets it a moment late, with a
 * fade. Hidden is `visibility: hidden`, so the slot keeps its width and the link
 * leaves the tab order and the accessibility tree.
 */
function HeaderPhoneInstall({ headerRef }: { headerRef: RefObject<HTMLElement | null> }) {
  const { t } = useTranslation('common');
  const { platform, nativeStore } = useInstallPlatform();
  const inboundCampaign = useInboundCampaign();
  const badgeOnScreen = useStoreBadgeOnScreen(headerRef);
  const headerInstall = resolveHeroInstall(platform, nativeStore);
  const headerStore = headerInstall.stores[0];
  let badgeOnScreenAttribute: 'yes' | 'no' | undefined;
  if (badgeOnScreen !== null) badgeOnScreenAttribute = badgeOnScreen ? 'yes' : 'no';

  return (
    <Button
      className={styles.phoneInstall}
      data-store-badge-on-screen={badgeOnScreenAttribute}
      href={buildStoreUrl(headerStore, { placement: 'header', inbound: inboundCampaign })}
      target="_blank"
      rel="noopener noreferrer"
      variant="outlined"
      sx={HEADER_START_CLIMBING_SX}
      onClick={() =>
        trackAppInstallClick({
          platform: headerStore,
          source: headerStore === 'ios' ? 'app-store' : 'google-play',
          placement: 'header',
          mode: headerInstall.mode,
        })
      }
    >
      {t('header.getApp')}
    </Button>
  );
}

function getProfileHeaderConfig(pathname: string, t: (key: string) => string): ProfileHeaderConfig | null {
  const segments = pathname.split('/').filter(Boolean);

  if (segments[0] !== 'profile' || !segments[1]) {
    return null;
  }

  const userId = segments[1];
  const childPage = segments[2];

  if (!childPage) {
    return {
      userId,
      title: t('header.profile'),
      backUrl: '/',
      isRoot: true,
    };
  }

  const childPageTitles: Record<string, string> = {
    statistics: t('header.statistics'),
    sessions: t('header.sessions'),
    climbs: t('header.createdClimbs'),
  };

  return {
    userId,
    title: childPageTitles[childPage] ?? t('header.profile'),
    backUrl: `/profile/${userId}`,
    isRoot: false,
  };
}

/**
 * The www header. Boardsesh's climbing surfaces live in the app now, so this
 * carries no search field, no board context and no session state — it is the
 * brand link, the hand-off to the app, and the small set of account affordances
 * the marketing site still owns (`/profile`, `/settings`).
 *
 * The deleted UserDrawer used to be the only sign-in entry point outside
 * `/auth`, so the account slot below replaces it: a "Sign in" link when signed
 * out, a link to your own profile when signed in.
 */
export default function MarketingHeader() {
  const { t } = useTranslation('common');
  const headerRef = useRef<HTMLElement>(null);
  const { data: session } = useSession();
  const { showMessage } = useSnackbar();
  const [navMenuAnchor, setNavMenuAnchor] = useState<HTMLElement | null>(null);

  const statsFilterBridge = useStatsFilterBridge();
  const profileHeaderShare = useProfileHeaderShare();
  const pathname = usePathnameWithoutLocale();
  const profileHeaderConfig = getProfileHeaderConfig(pathname, t);

  const handleShareViewedProfile = useCallback(async () => {
    if (!profileHeaderConfig?.isRoot || !profileHeaderShare.isActive) return;

    const displayName = profileHeaderShare.displayName || t('share.viewedFallbackName');
    const shareUrl = `${window.location.origin}/profile/${profileHeaderConfig.userId}`;

    await shareWithFallback({
      url: shareUrl,
      title: t('share.profileTitle', { name: displayName }),
      text: t('share.profileText', { name: displayName }),
      trackingEvent: 'Profile Shared',
      trackingProps: {
        source: 'profile-header',
        userId: profileHeaderConfig.userId,
      },
      onClipboardSuccess: () => showMessage(t('share.linkCopied'), 'success'),
      onError: () => showMessage(t('share.shareFailed'), 'error'),
    });
  }, [profileHeaderConfig, profileHeaderShare.displayName, profileHeaderShare.isActive, showMessage, t]);

  const phoneInstallAction = <HeaderPhoneInstall headerRef={headerRef} />;

  const brandLink = (
    <Button
      component={LocaleLink}
      href="/"
      onClick={(click) => trackWebsiteJourneyLinkClick(click, navLinkClicked('header', '/'))}
      aria-label={t('ariaLabels.home')}
      sx={BRAND_SX}
      disableRipple
    >
      <BrandLockup eager />
    </Button>
  );

  const navLinks: { href: WebsiteNavTarget; label: string }[] = [
    { href: '/boards', label: t('header.nav.boards') },
    { href: '/gyms', label: t('header.nav.gyms') },
    { href: '/spraywalls', label: t('header.nav.spray') },
    { href: '/playlists', label: t('header.nav.playlists') },
    { href: '/help', label: t('header.nav.help') },
  ];

  const primaryNav = (
    <>
      <Box component="nav" aria-label={t('header.navLabel')} className={styles.nav}>
        {navLinks.map(({ href, label }) => (
          <MuiLink
            key={href}
            component={LocaleLink}
            href={href}
            onClick={() => trackWebsiteJourneyEvent(navLinkClicked('header', href))}
            variant="body2"
            aria-current={isNavigationActive(pathname, href) ? 'page' : undefined}
            sx={NAV_LINK_SX}
          >
            {label}
          </MuiLink>
        ))}
      </Box>
      <div className={styles.navMenuSlot}>
        <IconButton
          aria-label={t('ariaLabels.openMenu')}
          aria-haspopup="menu"
          aria-expanded={navMenuAnchor !== null}
          onClick={(event) => setNavMenuAnchor(event.currentTarget)}
          size="small"
        >
          <MenuOutlined />
        </IconButton>
        <Menu
          anchorEl={navMenuAnchor}
          open={navMenuAnchor !== null}
          onClose={() => setNavMenuAnchor(null)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
          transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        >
          {!session?.user?.id && (
            <MenuItem component={LocaleLink} href="/auth/login" onClick={() => setNavMenuAnchor(null)}>
              {t('header.signIn')}
            </MenuItem>
          )}
          {session?.user?.id && (
            <MenuItem
              component={LocaleLink}
              href={`/profile/${session.user.id}`}
              onClick={() => {
                trackWebsiteJourneyEvent(navLinkClicked('header-menu', 'profile'));
                setNavMenuAnchor(null);
              }}
            >
              {t('ariaLabels.yourProfile')}
            </MenuItem>
          )}
          {session?.user?.id && (
            <MenuItem component={LocaleLink} href="/settings" onClick={() => setNavMenuAnchor(null)}>
              {t('ariaLabels.settings')}
            </MenuItem>
          )}
          {navLinks.map(({ href, label }) => (
            <MenuItem
              key={href}
              component={LocaleLink}
              href={href}
              selected={isNavigationActive(pathname, href)}
              aria-current={isNavigationActive(pathname, href) ? 'page' : undefined}
              onClick={() => {
                trackWebsiteJourneyEvent(navLinkClicked('header-menu', href));
                setNavMenuAnchor(null);
              }}
            >
              {label}
            </MenuItem>
          ))}
          <MenuItem
            component="a"
            href={APP_URL}
            onClick={(click) => {
              trackWebsiteJourneyLinkClick(click, webAppOpened('header-menu'));
              setNavMenuAnchor(null);
            }}
            className={styles.mobileAppLink}
          >
            {t('header.startClimbing')}
          </MenuItem>
        </Menu>
      </div>
    </>
  );

  // Signed-in climbers get two destinations here: the public profile and
  // settings. `/you` is gone and W-20b (#4439) moved notifications into the
  // app, so this account slot is what keeps `/settings` reachable from www at
  // all.
  const accountAction = session?.user?.id ? (
    <>
      <IconButton
        component={LocaleLink}
        href={`/profile/${session.user.id}`}
        onClick={() => trackWebsiteJourneyEvent(navLinkClicked('header', 'profile'))}
        aria-label={t('ariaLabels.yourProfile')}
        size="small"
      >
        <PersonOutlined />
      </IconButton>
      <IconButton
        component={LocaleLink}
        href="/settings"
        onClick={() => trackWebsiteJourneyEvent(navLinkClicked('header', '/settings'))}
        aria-label={t('ariaLabels.settings')}
        size="small"
      >
        <SettingsOutlined />
      </IconButton>
    </>
  ) : (
    <Button
      component={LocaleLink}
      href="/auth/login"
      onClick={() => trackWebsiteJourneyEvent(navLinkClicked('header', '/auth/login'))}
      aria-label={t('header.signIn')}
      size="small"
      // `inherit`, not primary: "Sign in" is account chrome in the label ink, not
      // a violet text action, and a primary text button lifts to violet on hover.
      color="inherit"
      className={styles.signIn}
      sx={SIGN_IN_SX}
    >
      <PersonOutlined className={styles.signInIcon} />
      <Box component="span" className={styles.signInLabel}>
        {t('header.signIn')}
      </Box>
    </Button>
  );

  // Chrome-less surfaces (kiosk TVs, embeds) render zero app chrome — the
  // kiosk brings its own 64px brand header and a strict 100dvh no-scroll frame.
  if (isChromeLessPath(pathname)) {
    return null;
  }

  // On /profile pages, show a centered title with a back button in the left slot.
  if (profileHeaderConfig) {
    const title = statsFilterBridge.isActive
      ? (statsFilterBridge.pageTitle ?? profileHeaderConfig.title)
      : profileHeaderConfig.title;
    const backUrl = statsFilterBridge.isActive
      ? (statsFilterBridge.backUrl ?? profileHeaderConfig.backUrl)
      : profileHeaderConfig.backUrl;

    return (
      <CenteredHeader
        left={<BackButton fallbackUrl={backUrl} />}
        title={title}
        right={
          <div className={styles.headerActions}>
            {statsFilterBridge.isActive && (
              <div className={styles.iconButtonWrapper}>
                <IconButton
                  onClick={() => statsFilterBridge.openFilterDrawer?.()}
                  aria-label={t('ariaLabels.openStatsFilters')}
                  size="small"
                >
                  <TuneOutlined />
                </IconButton>
                {statsFilterBridge.hasActiveFilters && <span className={styles.filterActiveIndicator} />}
              </div>
            )}
            {!statsFilterBridge.isActive && profileHeaderConfig.isRoot && profileHeaderShare.isActive && (
              <IconButton onClick={handleShareViewedProfile} aria-label={t('ariaLabels.shareProfile')} size="small">
                <IosShareOutlined />
              </IconButton>
            )}
          </div>
        }
      />
    );
  }

  // On /settings pages, brand link only — no settings cog, you're already here.
  if (pathname.startsWith('/settings')) {
    return (
      <header ref={headerRef} className={styles.header} data-testid="marketing-header">
        {brandLink}
        <Box sx={{ flex: 1 }} />
        {phoneInstallAction}
      </header>
    );
  }

  return (
    <header ref={headerRef} className={styles.header} data-testid="marketing-header">
      {brandLink}
      {primaryNav}
      <Box sx={{ flex: 1 }} />
      <Box className={styles.accountSlot}>{accountAction}</Box>
      {phoneInstallAction}
      <Box className={styles.desktopAppLink}>
        <StartClimbingButton
          label={t('header.startClimbing')}
          ariaLabel={t('ariaLabels.startClimbing')}
          size="small"
          placement="header"
          variant="outlined"
          sx={HEADER_START_CLIMBING_SX}
        />
      </Box>
    </header>
  );
}
