'use client';

// Overview tab: the manage-console landing surface. It reuses data the page
// already holds (the enriched gym's counts) plus one lightweight kiosk-count
// query (shared cache key with the welcome card, so no extra round-trip) to show
// an at-a-glance summary, deep links into every other tab, a link to the public
// page, and a first-class "embed the leaderboard" action reusing the kiosk
// editor's dialog. The welcome checklist lives at the top of this surface.

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import Button from '@mui/material/Button';
import MuiLink from '@mui/material/Link';
import Skeleton from '@mui/material/Skeleton';
import TvOutlined from '@mui/icons-material/TvOutlined';
import PaletteOutlined from '@mui/icons-material/PaletteOutlined';
import FitnessCenterOutlined from '@mui/icons-material/FitnessCenterOutlined';
import PeopleOutlined from '@mui/icons-material/PeopleOutlined';
import PersonOutlined from '@mui/icons-material/PersonOutlined';
import InsightsOutlined from '@mui/icons-material/InsightsOutlined';
import BadgeOutlined from '@mui/icons-material/BadgeOutlined';
import ArrowForwardOutlined from '@mui/icons-material/ArrowForwardOutlined';
import LaunchOutlined from '@mui/icons-material/LaunchOutlined';
import CodeOutlined from '@mui/icons-material/CodeOutlined';
import PrintOutlined from '@mui/icons-material/PrintOutlined';
import type { Gym } from '@boardsesh/shared-schema';
import {
  GET_GYM_KIOSKS,
  type GetGymKiosksQueryResponse,
  type GetGymKiosksQueryVariables,
} from '@boardsesh/graphql/operations';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { getBackendHttpUrl } from '@/app/lib/backend-url';
import { resolveGymLogoDisplayUrl } from '@/app/lib/gym-logo-display-url';
import LocaleLink from '@/app/components/i18n/locale-link';
import GymStatChip from '@/app/components/gym-entity/gym-stat-chip';
import { themeTokens } from '@/app/theme/theme-config';
import GymWelcomeCard from './gym-welcome-card';
import EmbedCodeDialog, { type EmbedCodeDialogState } from './embed-code-dialog';
import { buildLeaderboardEmbedSnippet } from './embed-snippets';

type QuickLinkTab = 'kiosks' | 'branding' | 'boards' | 'members' | 'insights' | 'profile';

export default function OverviewTab({ gym }: { gym: Gym }) {
  const { t } = useTranslation('kiosk');
  const { token } = useWsAuthToken();
  const { data: session } = useSession();
  const viewerUserId = session?.user?.id ?? 'anonymous';
  const [embedDialog, setEmbedDialog] = useState<EmbedCodeDialogState | null>(null);

  // Kiosk count: the one summary number not already on the gym. Same query key
  // the welcome card uses, so the two share a single fetch.
  const { data: kiosks, isError: kiosksError } = useQuery({
    queryKey: ['gymKiosks', gym.uuid, viewerUserId],
    queryFn: async () => {
      const client = createGraphQLHttpClient(token);
      const response = await client.request<GetGymKiosksQueryResponse, GetGymKiosksQueryVariables>(GET_GYM_KIOSKS, {
        gymUuid: gym.uuid,
      });
      return response.gymKiosks;
    },
    enabled: !!token,
  });
  // The other three counts are server-passed and stable; the kiosk count is the
  // one async value. Show the count once resolved; while the fetch is in flight a
  // skeleton, and on failure an em-dash — never a misleading hard 0 and never a
  // stuck spinner (a failed fetch would otherwise sit on the placeholder forever).
  let kioskCountDisplay: React.ReactNode;
  if (kiosks !== undefined) {
    kioskCountDisplay = kiosks.length;
  } else if (kiosksError) {
    kioskCountDisplay = '—';
  } else {
    kioskCountDisplay = <Skeleton variant="text" width={14} sx={{ display: 'inline-block' }} />;
  }

  const logoDisplayUrl = resolveGymLogoDisplayUrl(gym.logoUrl ?? null, getBackendHttpUrl());

  // Deep-link base: prefer the slug, fall back to the UUID (the manage route
  // resolves both). Overview is the default tab, so every link is explicit.
  const gymRef = gym.slug || gym.uuid;
  const tabHref = (tab: QuickLinkTab): string => `/gym/${gymRef}/manage?tab=${tab}`;

  const quickLinks: { tab: QuickLinkTab; icon: React.ReactNode; title: string; body: string }[] = [
    {
      tab: 'kiosks',
      icon: <TvOutlined />,
      title: t('manage.overview.quickLinks.kiosks.title'),
      body: t('manage.overview.quickLinks.kiosks.body'),
    },
    {
      tab: 'branding',
      icon: <PaletteOutlined />,
      title: t('manage.overview.quickLinks.branding.title'),
      body: t('manage.overview.quickLinks.branding.body'),
    },
    {
      tab: 'boards',
      icon: <FitnessCenterOutlined />,
      title: t('manage.overview.quickLinks.boards.title'),
      body: t('manage.overview.quickLinks.boards.body'),
    },
    {
      tab: 'members',
      icon: <PeopleOutlined />,
      title: t('manage.overview.quickLinks.members.title'),
      body: t('manage.overview.quickLinks.members.body'),
    },
    {
      tab: 'insights',
      icon: <InsightsOutlined />,
      title: t('manage.overview.quickLinks.insights.title'),
      body: t('manage.overview.quickLinks.insights.body'),
    },
    {
      tab: 'profile',
      icon: <BadgeOutlined />,
      title: t('manage.overview.quickLinks.profile.title'),
      body: t('manage.overview.quickLinks.profile.body'),
    },
  ];

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <GymWelcomeCard gym={gym} />

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        {logoDisplayUrl && (
          <Box
            component="img"
            src={logoDisplayUrl}
            alt={gym.name}
            sx={{ width: 56, height: 56, borderRadius: 2, objectFit: 'contain', flexShrink: 0 }}
          />
        )}
        <Typography variant="h5" sx={{ fontWeight: themeTokens.typography.fontWeight.bold, minWidth: 0 }}>
          {gym.name}
        </Typography>
      </Box>

      <Box sx={{ display: 'flex', gap: 2.5, flexWrap: 'wrap' }}>
        <GymStatChip
          icon={<PeopleOutlined sx={{ fontSize: 18 }} />}
          value={gym.followerCount}
          label={t('manage.overview.stats.followers')}
        />
        <GymStatChip
          icon={<PersonOutlined sx={{ fontSize: 18 }} />}
          value={gym.memberCount}
          label={t('manage.overview.stats.members')}
        />
        <GymStatChip
          icon={<FitnessCenterOutlined sx={{ fontSize: 18 }} />}
          value={gym.boardCount}
          label={t('manage.overview.stats.boards')}
        />
        <GymStatChip
          icon={<TvOutlined sx={{ fontSize: 18 }} />}
          value={kioskCountDisplay}
          label={t('manage.overview.stats.kiosks')}
        />
      </Box>

      <Box>
        <Typography variant="subtitle2" sx={{ fontWeight: themeTokens.typography.fontWeight.semibold, mb: 1.5 }}>
          {t('manage.overview.quickLinksHeading')}
        </Typography>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
            gap: 1.5,
          }}
        >
          {quickLinks.map((link) => (
            <Card
              key={link.tab}
              variant="outlined"
              sx={{ borderRadius: themeTokens.borderRadius.md, borderColor: 'divider' }}
            >
              <MuiLink
                component={LocaleLink}
                href={tabHref(link.tab)}
                underline="none"
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.5,
                  p: 2,
                  color: 'text.primary',
                  '&:hover': { bgcolor: 'action.hover' },
                }}
              >
                <Box sx={{ color: 'primary.main', display: 'flex' }}>{link.icon}</Box>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="body2" sx={{ fontWeight: themeTokens.typography.fontWeight.semibold }}>
                    {link.title}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {link.body}
                  </Typography>
                </Box>
                <ArrowForwardOutlined sx={{ fontSize: 18, color: 'primary.main' }} />
              </MuiLink>
            </Card>
          ))}
        </Box>
      </Box>

      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
        {gym.slug && (
          <Button
            component={LocaleLink}
            href={`/gym/${gym.slug}`}
            variant="outlined"
            size="small"
            startIcon={<LaunchOutlined />}
            sx={{ textTransform: 'none' }}
          >
            {t('manage.overview.viewPublicPage')}
          </Button>
        )}
        {/* Slug-gated, like the public-page link above it: the poster route is
            addressed by slug only (a slug-less legacy gym reaches this console
            by UUID), and the printed code has to encode the canonical slug —
            there is no poster to print until the gym has one. */}
        {gym.slug && (
          <Button
            component={LocaleLink}
            href={`/gym/${gym.slug}/poster`}
            variant="outlined"
            size="small"
            startIcon={<PrintOutlined />}
            sx={{ textTransform: 'none' }}
          >
            {t('manage.overview.printPoster')}
          </Button>
        )}
        <Button
          variant="outlined"
          size="small"
          startIcon={<CodeOutlined />}
          onClick={() =>
            setEmbedDialog({
              title: t('embed.railDialogTitle', { name: gym.name }),
              snippet: buildLeaderboardEmbedSnippet({ gymUuid: gym.uuid, gymName: gym.name }),
              showPeriodNote: true,
            })
          }
          sx={{ textTransform: 'none' }}
        >
          {t('manage.overview.embedAction')}
        </Button>
      </Box>

      <EmbedCodeDialog state={embedDialog} onClose={() => setEmbedDialog(null)} />
    </Box>
  );
}
