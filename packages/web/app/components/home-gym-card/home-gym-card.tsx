'use client';

import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from 'next-auth/react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import FitnessCenterOutlined from '@mui/icons-material/FitnessCenterOutlined';
import SettingsOutlined from '@mui/icons-material/SettingsOutlined';
import VisibilityOutlined from '@mui/icons-material/VisibilityOutlined';
import LocaleLink from '@/app/components/i18n/locale-link';
import { useFeatureFlag } from '@/app/components/providers/feature-flags-provider';
import { GYM_KIOSK_FLAG } from '@/app/flags';
import { useMyGyms } from '@/app/hooks/use-my-gyms';
import { resolveGymRole, type GymRoleKind } from '@/app/lib/gym-role';
import { themeTokens } from '@/app/theme/theme-config';

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
  backgroundColor: themeTokens.colors.infoTint,
  color: 'var(--color-info)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
} as const;

/**
 * Signed-in homepage card for a gym you help run: the gym's name plus real
 * links into `/gym/{slug}` and `/gym/{slug}/manage`. Signed-out visitors, and
 * signed-in climbers with no gym, see nothing.
 *
 * The "Find your gym" nudge, the multi-gym "and N more" drawer and the
 * `Homepage Gym Card Click` event were removed with the search and my-gyms
 * drawers they opened. The homepage has no gym-discovery affordance until
 * #4372 builds a crawlable gyms directory to point at — deliberately not
 * invented here.
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
  const { gyms, error, hasResolved } = useMyGyms(true);
  // Kill switch for the manage surface — mirrors the My Gyms drawer, which
  // hides the Manage button until the gym-kiosk feature ships broadly. The
  // View action stays ungated.
  const kioskFlag = useFeatureFlag(GYM_KIOSK_FLAG);

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

  // Wait for the gyms fetch to definitively resolve before rendering.
  // `hasResolved` stays false while the ws-auth token is still in flight, so
  // this never misreads "idle, pre-token" as "loaded with zero gyms" (see
  // use-my-gyms.ts).
  if (error || !hasResolved) return null;
  if (gyms.length === 0) return null;

  return (
    <OwnerGymCard
      gym={gyms[0]}
      role={resolveGymRole(gyms[0], currentUserId)}
      roleLabel={roleLabel}
      kioskFlag={Boolean(kioskFlag)}
      ownerSubtitle={t('home.gymCard.ownerSubtitle')}
      manageLabel={t('home.gymCard.manage')}
      viewLabel={t('home.gymCard.viewPage')}
    />
  );
}

type OwnerGymCardProps = {
  gym: ReturnType<typeof useMyGyms>['gyms'][number];
  role: GymRoleKind | null;
  roleLabel: (role: GymRoleKind) => string;
  kioskFlag: boolean;
  ownerSubtitle: string;
  manageLabel: string;
  viewLabel: string;
};

function OwnerGymCard({ gym, role, roleLabel, kioskFlag, ownerSubtitle, manageLabel, viewLabel }: OwnerGymCardProps) {
  // The manage route resolves a bare UUID (slug-less legacy gyms); the public
  // gym page only resolves by slug — so "View page" is offered only with a slug.
  const showManage = gym.canEdit && kioskFlag;
  const manageHref = `/gym/${gym.slug ?? gym.uuid}/manage`;
  const viewHref = gym.slug ? `/gym/${gym.slug}` : null;

  // Nothing actionable (no manage access, no public page) — skip the card
  // entirely rather than show a dead-end owner row.
  if (!showManage && !viewHref) return null;

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
          </Box>
        </Box>
      </CardContent>
    </Card>
  );
}
