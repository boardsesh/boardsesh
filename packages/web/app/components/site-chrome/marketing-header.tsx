'use client';

import React, { useCallback } from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Button from '@mui/material/Button';
import Badge from '@mui/material/Badge';
import Typography from '@mui/material/Typography';
import SettingsOutlined from '@mui/icons-material/SettingsOutlined';
import IosShareOutlined from '@mui/icons-material/IosShare';
import NotificationsOutlined from '@mui/icons-material/NotificationsOutlined';
import PersonOutlined from '@mui/icons-material/PersonOutlined';
import InsightsOutlined from '@mui/icons-material/InsightsOutlined';
import TuneOutlined from '@mui/icons-material/TuneOutlined';
import { useSession } from 'next-auth/react';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import BackButton from '@/app/components/back-button';
import StartClimbingButton from '@/app/components/start-climbing-button';
import { useUnreadNotificationCount } from '@/app/hooks/use-unread-notification-count';
import { shareWithFallback } from '@/app/lib/share-utils';
import { isChromeLessPath } from '@/app/lib/chrome-less-routes';
import { usePathnameWithoutLocale } from '@/app/lib/i18n/use-locale-router';
import { useStatsFilterBridge } from '@/app/components/stats-filter-bridge/stats-filter-bridge-context';
import { useProfileHeaderShare } from '@/app/components/profile-header-bridge/profile-header-bridge-context';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { themeTokens } from '@/app/theme/theme-config';
import styles from './marketing-header.module.css';

const BADGE_SMALL_SX = { '& .MuiBadge-badge': themeTokens.badge.small } as const;

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
 * the marketing site still owns (`/you`, `/profile`, `/settings`).
 *
 * The deleted UserDrawer used to be the only sign-in entry point outside
 * `/auth`, so the account slot below replaces it: a "Sign in" link when signed
 * out, a link to your own profile when signed in.
 */
export default function MarketingHeader() {
  const { t } = useTranslation('common');
  const { data: session } = useSession();
  const { showMessage } = useSnackbar();

  const notificationUnreadCount = useUnreadNotificationCount();
  const statsFilterBridge = useStatsFilterBridge();
  const profileHeaderShare = useProfileHeaderShare();
  const pathname = usePathnameWithoutLocale();
  const profileHeaderConfig = getProfileHeaderConfig(pathname, t);

  const handleShareOwnProfile = useCallback(() => {
    if (!session?.user?.id) return;

    const shareUrl = `${window.location.origin}/profile/${session.user.id}`;
    const displayName = session.user.name || t('share.fallbackName');

    void shareWithFallback({
      url: shareUrl,
      title: t('share.profileTitle', { name: displayName }),
      text: t('share.profileText', { name: displayName }),
      trackingEvent: 'Profile Shared',
      trackingProps: { source: 'you-header' },
    });
  }, [session, t]);

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

  // Signed-in climbers get two destinations here: the private dashboard and the
  // public profile. The dashboard link is the only entry point to `/you` now
  // that the bottom tab bar is gone, and `/you` is in turn the only place that
  // carries the notification bell.
  const accountAction = session?.user?.id ? (
    <>
      <IconButton component={LocaleLink} href="/you" aria-label={t('ariaLabels.yourDashboard')} size="small">
        <InsightsOutlined />
      </IconButton>
      <IconButton
        component={LocaleLink}
        href={`/profile/${session.user.id}`}
        aria-label={t('ariaLabels.yourProfile')}
        size="small"
      >
        <PersonOutlined />
      </IconButton>
    </>
  ) : (
    <Button component={LocaleLink} href="/auth/login" size="small" sx={{ textTransform: 'none', flexShrink: 0 }}>
      {t('header.signIn')}
    </Button>
  );

  const notificationButton = (
    <IconButton component={LocaleLink} href="/notifications" aria-label={t('ariaLabels.notifications')} size="small">
      <Badge badgeContent={notificationUnreadCount} color="error" max={99} sx={BADGE_SMALL_SX}>
        <NotificationsOutlined />
      </Badge>
    </IconButton>
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

  // On the root /you page, show a centered title with the brand link anchored left.
  if (pathname === '/you') {
    return (
      <CenteredHeader
        left={
          <div className={styles.headerActions}>
            {brandLink}
            <IconButton component={LocaleLink} href="/settings" aria-label={t('ariaLabels.settings')} size="small">
              <SettingsOutlined />
            </IconButton>
          </div>
        }
        title={t('header.you')}
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
            {session?.user?.id && (
              <IconButton onClick={handleShareOwnProfile} aria-label={t('ariaLabels.shareProfile')} size="small">
                <IosShareOutlined />
              </IconButton>
            )}
            {notificationButton}
          </div>
        }
      />
    );
  }

  // On /you child pages: brand link + share + notifications + settings cog.
  if (pathname.startsWith('/you')) {
    return (
      <header className={styles.header} data-testid="marketing-header">
        {brandLink}
        <Box sx={{ flex: 1 }} />
        {session?.user?.id && (
          <IconButton onClick={handleShareOwnProfile} aria-label={t('ariaLabels.shareProfile')} size="small">
            <IosShareOutlined />
          </IconButton>
        )}
        {notificationButton}
        <IconButton component={LocaleLink} href="/settings" aria-label={t('ariaLabels.settings')} size="small">
          <SettingsOutlined />
        </IconButton>
      </header>
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
