'use client';

// First-run welcome checklist for the manage console. Self-contained: it mounts
// at the top of the manage content, derives each step's done-state from data
// already on the page (gym prop + two lightweight queries), deep-links each step
// to the matching tab, and stays dismissed per-gym in IndexedDB.
//
// Keep the checklist logic inside this component — the console will later grow an
// Overview tab, and nothing here should be spread across the individual tabs.

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useQuery } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import MuiLink from '@mui/material/Link';
import CloseOutlined from '@mui/icons-material/CloseOutlined';
import CheckCircle from '@mui/icons-material/CheckCircle';
import RadioButtonUnchecked from '@mui/icons-material/RadioButtonUnchecked';
import ArrowForwardOutlined from '@mui/icons-material/ArrowForwardOutlined';
import CelebrationOutlined from '@mui/icons-material/CelebrationOutlined';
import type { Gym } from '@boardsesh/shared-schema';
import {
  GET_GYM_KIOSKS,
  GET_GYM_MEMBERS,
  type GetGymKiosksQueryResponse,
  type GetGymKiosksQueryVariables,
  type GetGymMembersQueryResponse,
  type GetGymMembersQueryVariables,
} from '@boardsesh/graphql/operations';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import LocaleLink from '@/app/components/i18n/locale-link';
import { themeTokens } from '@/app/theme/theme-config';
import { dismissGymWelcome, isGymWelcomeDismissed } from '@/app/lib/gym-welcome-db';
import {
  deriveGymChecklistSteps,
  completedChecklistCount,
  CHECKLIST_STEP_TAB,
  type GymChecklistStepKey,
} from './gym-welcome-steps';

// Static-literal lookup: the i18n linter forbids t(variable)/t(template).
function stepTitle(t: TFunction, key: GymChecklistStepKey): string {
  switch (key) {
    case 'kiosk':
      return t('manage.welcome.steps.kiosk.title');
    case 'branding':
      return t('manage.welcome.steps.branding.title');
    case 'boards':
      return t('manage.welcome.steps.boards.title');
    case 'members':
      return t('manage.welcome.steps.members.title');
  }
}

function stepBody(t: TFunction, key: GymChecklistStepKey): string {
  switch (key) {
    case 'kiosk':
      return t('manage.welcome.steps.kiosk.body');
    case 'branding':
      return t('manage.welcome.steps.branding.body');
    case 'boards':
      return t('manage.welcome.steps.boards.body');
    case 'members':
      return t('manage.welcome.steps.members.body');
  }
}

export default function GymWelcomeCard({ gym }: { gym: Gym }) {
  const { t } = useTranslation('kiosk');
  const { token } = useWsAuthToken();
  const { data: session } = useSession();
  const viewerUserId = session?.user?.id ?? 'anonymous';

  // null = dismissal state not yet resolved (avoid a flash before IndexedDB answers).
  const [dismissed, setDismissed] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    void isGymWelcomeDismissed(gym.uuid).then((value) => {
      if (active) setDismissed(value);
    });
    return () => {
      active = false;
    };
  }, [gym.uuid]);

  const { data: kiosks } = useQuery({
    queryKey: ['gymKiosks', gym.uuid, viewerUserId],
    queryFn: async () => {
      const client = createGraphQLHttpClient(token);
      const response = await client.request<GetGymKiosksQueryResponse, GetGymKiosksQueryVariables>(GET_GYM_KIOSKS, {
        gymUuid: gym.uuid,
      });
      return response.gymKiosks;
    },
    enabled: !!token && dismissed === false,
  });

  const { data: members } = useQuery({
    queryKey: ['gymMembers', gym.uuid, viewerUserId],
    queryFn: async () => {
      const client = createGraphQLHttpClient(token);
      // We only need to know whether ANY non-owner member exists. There is a
      // single owner, so any page of members holds at most one owner row — the
      // first 50 always include a non-owner whenever one exists.
      const response = await client.request<GetGymMembersQueryResponse, GetGymMembersQueryVariables>(GET_GYM_MEMBERS, {
        input: { gymUuid: gym.uuid, limit: 50 },
      });
      return response.gymMembers.members;
    },
    enabled: !!token && dismissed === false,
  });

  if (dismissed !== false) {
    return null;
  }

  const hasBranding = Boolean(gym.logoUrl || gym.brandPrimaryColor || gym.brandAccentColor || gym.brandBackgroundColor);
  const nonOwnerMemberCount = (members ?? []).filter((member) => member.userId !== gym.ownerId).length;

  const steps = deriveGymChecklistSteps({
    kioskCount: (kiosks ?? []).length,
    hasBranding,
    boardCount: gym.boardCount,
    nonOwnerMemberCount,
  });
  const doneCount = completedChecklistCount(steps);
  const allDone = doneCount === steps.length;

  // Deep-link base: prefer the slug, fall back to the UUID (the manage route resolves both).
  const gymRef = gym.slug || gym.uuid;
  const tabHref = (key: GymChecklistStepKey): string => {
    // Overview is the default tab now, so every checklist step links explicitly
    // to its own tab (none of the steps target Overview).
    const tab = CHECKLIST_STEP_TAB[key];
    return `/gym/${gymRef}/manage?tab=${tab}`;
  };

  const handleDismiss = () => {
    setDismissed(true);
    void dismissGymWelcome(gym.uuid);
  };

  return (
    <Card
      variant="outlined"
      sx={{
        mb: 3,
        borderColor: 'divider',
        borderRadius: themeTokens.borderRadius.lg,
        overflow: 'hidden',
      }}
    >
      <CardContent sx={{ p: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1, mb: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <CelebrationOutlined sx={{ color: 'var(--neutral-500)' }} />
            <Box>
              <Typography variant="h6" sx={{ fontWeight: themeTokens.typography.fontWeight.bold, lineHeight: 1.2 }}>
                {allDone ? t('manage.welcome.allDoneTitle') : t('manage.welcome.title')}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {allDone
                  ? t('manage.welcome.allDoneBody')
                  : t('manage.welcome.progress', { done: doneCount, total: steps.length })}
              </Typography>
            </Box>
          </Box>
          <IconButton onClick={handleDismiss} size="small" aria-label={t('manage.welcome.dismiss')}>
            <CloseOutlined fontSize="small" />
          </IconButton>
        </Box>

        <Stack spacing={1}>
          {steps.map((step) => (
            <MuiLink
              key={step.key}
              component={LocaleLink}
              href={tabHref(step.key)}
              underline="none"
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1.5,
                p: 1.5,
                borderRadius: themeTokens.borderRadius.md,
                color: 'text.primary',
                backgroundColor: 'var(--neutral-100)',
                '&:hover': { backgroundColor: 'var(--neutral-200)' },
              }}
            >
              {step.done ? (
                <CheckCircle sx={{ color: 'success.main' }} />
              ) : (
                <RadioButtonUnchecked sx={{ color: 'var(--neutral-400)' }} />
              )}
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography
                  variant="body2"
                  sx={{
                    fontWeight: themeTokens.typography.fontWeight.semibold,
                    textDecoration: step.done ? 'line-through' : 'none',
                    color: step.done ? 'text.secondary' : 'text.primary',
                  }}
                >
                  {stepTitle(t, step.key)}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {stepBody(t, step.key)}
                </Typography>
              </Box>
              {!step.done && <ArrowForwardOutlined fontSize="small" sx={{ color: 'var(--neutral-500)' }} />}
            </MuiLink>
          ))}
        </Stack>
      </CardContent>
    </Card>
  );
}
