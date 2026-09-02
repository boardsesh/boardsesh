'use client';

import React, { useCallback, useState } from 'react';
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
import styles from './marketing-header.module.css';

// Compact brand-fill capsule for the persistent "Start climbing" CTA that hands
// off to the Expo-web app. Matches the hero CTA's fill without the amber glow.
const HEADER_START_CLIMBING_SX = {
  flexShrink: 0,
  borderRadius: `${themeTokens.borderRadius.full}px`,
  textTransform: 'none',
  fontWeight: themeTokens.typography.fontWeight.semibold,
  px: 2,
  whiteSpace: 'nowrap',
  backgroundColor: 'var(--color-primary-fill)',
  color: 'var(--color-on-primary)',
  '&:hover': {
    backgroundColor: 'var(--color-primary-fill-hover)',
    transform: 'none',
  },
} as const;

const BRAND_SX = {
  flexShrink: 0,
  textTransform: 'none',
  fontWeight: themeTokens.typography.fontWeight.bold,
  fontSize: themeTokens.typography.fontSize.lg,
  color: 'var(--bs-text-brand-primary)',
  px: 0.5,
  '&:hover': { backgroundColor: 'transparent' },
} as const;

const NAV_LINK_SX = {
  color: 'var(--bs-text-brand-muted)',
  fontWeight: themeTokens.typography.fontWeight.medium,
  textDecoration: 'none',
  whiteSpace: 'nowrap',
  '&:hover': { color: 'var(--bs-text-brand-primary)', textDecoration: 'underline' },
} as const;

/** Route prefixes that render a simple title header instead of the default marketing header */
const TITLE_HEADER_PAGE_PREFIXES = ['/aurora-migration'] as const;

/** Pages where the header floats transparently over the hero */
const HIDDEN_HEADER_PAGES = ['/'];

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

  const brandLink = (
    <Button component={LocaleLink} href="/" aria-label={t('ariaLabels.home')} sx={BRAND_SX} disableRipple>
      {/* i18n-ignore-next-line — brand name, never translated (CLAUDE.md) */}
      Boardsesh
    </Button>
  );

  // The four destinations www still owns. `/boards` is deliberately absent —
  // the route does not exist, and the climbing UI it would have pointed at
  // moved to the app in W-16.
  const navLinks: { href: string; label: string }[] = [
    { href: '/gyms', label: t('header.nav.gyms') },
    { href: '/playlists', label: t('header.nav.playlists') },
    { href: '/about', label: t('header.nav.about') },
    { href: '/help', label: t('header.nav.help') },
  ];

  // Both treatments render the same four anchors. The inline row is always in
  // the DOM (CSS hides it below 900px rather than unmounting it), so a crawler
  // reads the links on every page regardless of viewport — the menu below is a
  // touch affordance, not the only copy of them.
  const primaryNav = (
    <>
      <Box component="nav" aria-label={t('header.navLabel')} className={styles.nav}>
        {navLinks.map(({ href, label }) => (
          <MuiLink key={href} component={LocaleLink} href={href} variant="body2" sx={NAV_LINK_SX}>
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
          {navLinks.map(({ href, label }) => (
            <MenuItem key={href} component={LocaleLink} href={href} onClick={() => setNavMenuAnchor(null)}>
              {label}
            </MenuItem>
          ))}
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
        aria-label={t('ariaLabels.yourProfile')}
        size="small"
      >
        <PersonOutlined />
      </IconButton>
      <IconButton component={LocaleLink} href="/settings" aria-label={t('ariaLabels.settings')} size="small">
        <SettingsOutlined />
      </IconButton>
    </>
  ) : (
    <Button component={LocaleLink} href="/auth/login" size="small" sx={{ textTransform: 'none', flexShrink: 0 }}>
      {t('header.signIn')}
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
      <header className={styles.header} data-testid="marketing-header">
        {brandLink}
        <Box sx={{ flex: 1 }} />
      </header>
    );
  }

  // Transparent bar over the homepage hero.
  if (HIDDEN_HEADER_PAGES.includes(pathname)) {
    return (
      <header className={styles.headerTransparent} data-testid="marketing-header">
        {brandLink}
        {primaryNav}
        <Box sx={{ flex: 1 }} />
        {accountAction}
        <StartClimbingButton
          label={t('header.startClimbing')}
          ariaLabel={t('ariaLabels.startClimbing')}
          size="small"
          sx={HEADER_START_CLIMBING_SX}
        />
      </header>
    );
  }

  // Translation keys live alongside the prefix list so the i18n linter can
  // statically follow `t('header.…')` to the catalog entry.
  const titleHeaderTitles: Record<(typeof TITLE_HEADER_PAGE_PREFIXES)[number], string> = {
    '/aurora-migration': t('header.auroraMigration'),
  };
  const titleHeaderPagePrefix = TITLE_HEADER_PAGE_PREFIXES.find((prefix) => pathname.startsWith(prefix));

  // Simple title header for specific pages (back button + title).
  if (titleHeaderPagePrefix) {
    return <CenteredHeader left={<BackButton fallbackUrl="/" />} title={titleHeaderTitles[titleHeaderPagePrefix]} />;
  }

  return (
    <header className={styles.header} data-testid="marketing-header">
      {brandLink}
      {primaryNav}
      <Box sx={{ flex: 1 }} />
      {accountAction}
      <StartClimbingButton
        label={t('header.startClimbing')}
        ariaLabel={t('ariaLabels.startClimbing')}
        size="small"
        sx={HEADER_START_CLIMBING_SX}
      />
    </header>
  );
}
