'use client';

import React, { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { useTranslation } from 'react-i18next';
import { useSession } from 'next-auth/react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import FitnessCenterOutlined from '@mui/icons-material/FitnessCenterOutlined';
import SettingsOutlined from '@mui/icons-material/SettingsOutlined';
import VisibilityOutlined from '@mui/icons-material/VisibilityOutlined';
import SearchOutlined from '@mui/icons-material/SearchOutlined';
import CloseOutlined from '@mui/icons-material/CloseOutlined';
import LocaleLink from '@/app/components/i18n/locale-link';
import { useFeatureFlag } from '@/app/components/providers/feature-flags-provider';
import { GYM_KIOSK_FLAG } from '@/app/flags';
import type { SearchCategory } from '@/app/components/search-drawer/unified-search-drawer';
import { useMyGyms } from '@/app/hooks/use-my-gyms';
import { resolveGymRole, type GymRoleKind } from '@/app/lib/gym-role';
import { getPreference, setPreference } from '@/app/lib/user-preferences-db';
import { track } from '@/app/lib/analytics';
import { themeTokens } from '@/app/theme/theme-config';

const MyGymsDrawer = dynamic(() => import('@/app/components/my-gyms-drawer/my-gyms-drawer'), { ssr: false });

const UnifiedSearchDrawer = dynamic(() => import('@/app/components/search-drawer/unified-search-drawer'), {
  ssr: false,
});

const DISMISS_PREFERENCE_KEY = 'homeGymCard:dismissed';

// Hoisted so the search drawer gets a stable array reference across renders.
const GYM_SEARCH_CATEGORIES: SearchCategory[] = ['gyms'];

// Same outlined-card language as the homepage OnboardingCard so the gym card
// slots into the stack without extra visual weight.
const cardSx = {
  borderRadius: `${themeTokens.borderRadius.lg}px`,
  border: '1px solid var(--neutral-200)',
  transition: themeTokens.transitions.fast,
  '&:hover': {
    borderColor: 'var(--neutral-300)',
    boxShadow: themeTokens.shadows.sm,
  },
} as const;

// Low-key violet-slate icon chip (matches the OnboardingCard 'help' accent) —
// the gym card is a quiet, contextual nudge, not a hero CTA.
const iconChipSx = {
  width: 44,
  height: 44,
  borderRadius: `${themeTokens.borderRadius.md}px`,
  backgroundColor: 'rgba(94, 100, 145, 0.12)',
  color: 'var(--color-info)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
} as const;

/**
 * Signed-in homepage nudge about gyms. Owners see their gym with Manage / View
 * actions; signed-in climbers without a gym get a low-key, dismissible "Find
 * your gym" card. Signed-out visitors see nothing.
 *
 * The authenticated body lives in a child component so the `useMyGyms`
 * GraphQL/React Query hooks never run for signed-out (or still-loading)
 * sessions — the card just returns null before mounting them.
 */
export default function HomeGymCard() {
  const { data: session, status } = useSession();
  if (status !== 'authenticated') return null;
  return <AuthedHomeGymCard currentUserId={session?.user?.id ?? null} />;
}

function AuthedHomeGymCard({ currentUserId }: { currentUserId: string | null }) {
  const { t } = useTranslation('marketing');
  const { t: tCommon } = useTranslation('common');
  const { gyms, isLoading, error } = useMyGyms(true);
  // Kill switch for the manage surface — mirrors the My Gyms drawer, which
  // hides the Manage button until the gym-kiosk feature ships broadly. The
  // View action stays ungated.
  const kioskFlag = useFeatureFlag(GYM_KIOSK_FLAG);

  // `null` = not yet resolved from IndexedDB; render nothing until we know so
  // the non-owner nudge never flashes and then vanishes.
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  const [myGymsOpen, setMyGymsOpen] = useState(false);
  const [myGymsRendered, setMyGymsRendered] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchRendered, setSearchRendered] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // getPreference already swallows IndexedDB errors and resolves null, but
    // guard the promise anyway so a rejection can never strand `dismissed` at
    // null (which would keep the non-owner nudge permanently hidden).
    void getPreference<boolean>(DISMISS_PREFERENCE_KEY)
      .then((value) => {
        if (!cancelled) setDismissed(Boolean(value));
      })
      .catch(() => {
        if (!cancelled) setDismissed(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const roleLabel = useCallback(
    (role: GymRoleKind): string => {
      switch (role) {
        case 'owner':
          return tCommon('myGyms.roleOwner');
        case 'admin':
          return tCommon('myGyms.roleAdmin');
        case 'editor':
          return tCommon('myGyms.roleEditor');
        case 'member':
          return tCommon('myGyms.roleMember');
        default:
          // Exhaustiveness guard: a new GymRoleKind fails to type-check here
          // rather than silently rendering a blank chip.
          role satisfies never;
          return '';
      }
    },
    [tCommon],
  );

  const openMyGyms = useCallback(() => {
    setMyGymsRendered(true);
    setMyGymsOpen(true);
    track('Homepage Gym Card Click', { action: 'open-my-gyms' });
  }, []);

  const openSearch = useCallback(() => {
    setSearchRendered(true);
    setSearchOpen(true);
    track('Homepage Gym Card Click', { action: 'find-gym' });
  }, []);

  const closeMyGyms = useCallback(() => setMyGymsOpen(false), []);
  const closeSearch = useCallback(() => setSearchOpen(false), []);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    void setPreference(DISMISS_PREFERENCE_KEY, true);
    track('Homepage Gym Card Click', { action: 'dismiss' });
  }, []);

  // Wait for the gyms fetch before deciding which variant to show — don't
  // guess non-owner while the request is still in flight.
  if (error || (isLoading && gyms.length === 0)) return null;

  if (gyms.length > 0) {
    return (
      <>
        <OwnerGymCard
          gym={gyms[0]}
          extraCount={gyms.length - 1}
          role={resolveGymRole(gyms[0], currentUserId)}
          roleLabel={roleLabel}
          kioskFlag={Boolean(kioskFlag)}
          onOpenMyGyms={openMyGyms}
          ownerSubtitle={t('home.gymCard.ownerSubtitle')}
          manageLabel={t('home.gymCard.manage')}
          viewLabel={t('home.gymCard.viewPage')}
          moreLabel={t('home.gymCard.andMore', { count: gyms.length - 1 })}
        />
        {myGymsRendered && <MyGymsDrawer open={myGymsOpen} onClose={closeMyGyms} />}
      </>
    );
  }

  // Non-owner: only render once we know the dismissal state and it's not set.
  if (dismissed !== false) return null;

  return (
    <>
      <Card variant="outlined" sx={cardSx} data-testid="home-gym-card-find">
        <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 2, px: 2.5 }}>
          <Box sx={iconChipSx}>
            <FitnessCenterOutlined />
          </Box>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography
                variant="body1"
                fontWeight={themeTokens.typography.fontWeight.semibold}
                sx={{ color: 'var(--neutral-900)', lineHeight: themeTokens.typography.lineHeight.tight, flex: 1 }}
              >
                {t('home.gymCard.findTitle')}
              </Typography>
              <IconButton
                size="small"
                onClick={handleDismiss}
                aria-label={t('home.gymCard.dismiss')}
                data-testid="home-gym-card-dismiss"
                sx={{ color: 'var(--neutral-400)', flexShrink: 0 }}
              >
                <CloseOutlined fontSize="small" />
              </IconButton>
            </Box>
            <Typography variant="body2" sx={{ color: 'var(--neutral-500)', mt: 0.25 }}>
              {t('home.gymCard.findDescription')}
            </Typography>
            <Button
              size="small"
              variant="outlined"
              startIcon={<SearchOutlined />}
              onClick={openSearch}
              data-testid="home-gym-card-find-cta"
              sx={{ textTransform: 'none', mt: 1.25 }}
            >
              {t('home.gymCard.findCta')}
            </Button>
          </Box>
        </CardContent>
      </Card>
      {searchRendered && (
        <UnifiedSearchDrawer
          open={searchOpen}
          onClose={closeSearch}
          defaultCategory="gyms"
          allowedCategories={GYM_SEARCH_CATEGORIES}
          showCloseButton
        />
      )}
    </>
  );
}

type OwnerGymCardProps = {
  gym: ReturnType<typeof useMyGyms>['gyms'][number];
  extraCount: number;
  role: GymRoleKind | null;
  roleLabel: (role: GymRoleKind) => string;
  kioskFlag: boolean;
  onOpenMyGyms: () => void;
  ownerSubtitle: string;
  manageLabel: string;
  viewLabel: string;
  moreLabel: string;
};

function OwnerGymCard({
  gym,
  extraCount,
  role,
  roleLabel,
  kioskFlag,
  onOpenMyGyms,
  ownerSubtitle,
  manageLabel,
  viewLabel,
  moreLabel,
}: OwnerGymCardProps) {
  // The manage route resolves a bare UUID (slug-less legacy gyms); the public
  // gym page only resolves by slug — so "View page" is offered only with a slug.
  const showManage = gym.canEdit && kioskFlag;
  const manageHref = `/gym/${gym.slug ?? gym.uuid}/manage`;
  const viewHref = gym.slug ? `/gym/${gym.slug}` : null;
  const showMore = extraCount > 0;

  // Nothing actionable (no manage access, no public page, single gym) — skip the
  // card entirely rather than show a dead-end owner row.
  if (!showManage && !viewHref && !showMore) return null;

  return (
    <Card variant="outlined" sx={cardSx} data-testid="home-gym-card-owner">
      <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 2, px: 2.5 }}>
        <Box sx={iconChipSx}>
          <FitnessCenterOutlined />
        </Box>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <Typography
              variant="body1"
              fontWeight={themeTokens.typography.fontWeight.semibold}
              sx={{ color: 'var(--neutral-900)', lineHeight: themeTokens.typography.lineHeight.tight }}
            >
              {gym.name}
            </Typography>
            {role && <Chip size="small" label={roleLabel(role)} color="primary" />}
          </Box>
          <Typography variant="body2" sx={{ color: 'var(--neutral-500)', mt: 0.25 }}>
            {ownerSubtitle}
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mt: 1.25 }}>
            {showManage && (
              <Button
                component={LocaleLink}
                href={manageHref}
                size="small"
                variant="outlined"
                startIcon={<SettingsOutlined />}
                data-testid="home-gym-card-manage"
                sx={{ textTransform: 'none' }}
              >
                {manageLabel}
              </Button>
            )}
            {viewHref && (
              <Button
                component={LocaleLink}
                href={viewHref}
                size="small"
                variant="text"
                startIcon={<VisibilityOutlined />}
                data-testid="home-gym-card-view"
                sx={{ textTransform: 'none' }}
              >
                {viewLabel}
              </Button>
            )}
            {showMore && (
              <Button
                size="small"
                variant="text"
                onClick={onOpenMyGyms}
                data-testid="home-gym-card-more"
                sx={{ textTransform: 'none', color: 'var(--neutral-500)' }}
              >
                {moreLabel}
              </Button>
            )}
          </Box>
        </Box>
      </CardContent>
    </Card>
  );
}
