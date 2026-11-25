// /embed/gym/[gym_uuid]/leaderboard — the gym leaderboard as an iframe widget
// for gym websites. Anonymous, cookieless, display-only; served with
// `Content-Security-Policy: frame-ancestors *` and WITHOUT X-Frame-Options
// (see next.config.mjs headers() + the middleware /embed carve-out).
//
//   ?period=day|week|month   default week ('day' = rolling "Last 24 hours").
//                            NO session mode here — embeds stay WebSocket-free.
//   ?board=<board uuid>      optional single-board scope; must be one of the
//                            gym's publicly listed boards, else widened to all.
//
// Recommended snippet (fixed-height design):
//   <iframe src="https://boardsesh.com/embed/gym/<uuid>/leaderboard"
//           width="100%" height="520" title="Gym leaderboard"></iframe>
//
// Keyed by the gym's immutable uuid (gym slugs are nullable AND editable — a
// rename would kill every embed pasted into a gym CMS).

import React from 'react';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import type { Gym } from '@boardsesh/shared-schema';
import { getLocale } from '@/app/lib/i18n/get-locale';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import I18nProvider from '@/app/components/providers/i18n-provider';
import EmbedShell from '@/app/components/kiosk/embed/embed-shell';
import EmbedLeaderboard from '@/app/components/kiosk/embed/embed-leaderboard';
import EmbedRetryState from '@/app/components/kiosk/embed/embed-retry';
import {
  embedAttributionHref,
  parseEmbedLeaderboardPeriod,
  resolveEmbedBrandGym,
  resolveEmbedLeaderboardScope,
} from '@/app/components/kiosk/embed/embed-access';
import { fetchGymBoardsForEmbed, fetchGymForEmbed } from '@/app/components/kiosk/embed/embed-fetchers';

type EmbedGymLeaderboardRouteProps = {
  params: Promise<{ gym_uuid: string }>;
  searchParams: Promise<{ period?: string; board?: string }>;
};

type PublicGymResult = { status: 'error' } | { status: 'ok'; gym: Gym | null };

/**
 * SECURITY GATE — `gym(gymUuid)` returns PRIVATE gyms fully enriched to
 * anonymous callers, so this page (and its metadata) must gate on
 * `gym.isPublic` itself: private or absent → `gym: null` (the page
 * notFound()s). A transient fetch failure stays distinguishable ('error' →
 * retry screen).
 */
async function fetchPublicGym(gymUuid: string): Promise<PublicGymResult> {
  const fetchResult = await fetchGymForEmbed(gymUuid);
  if (fetchResult.status === 'error') return { status: 'error' };
  return { status: 'ok', gym: resolveEmbedBrandGym(fetchResult.entity) };
}

export async function generateMetadata(props: EmbedGymLeaderboardRouteProps): Promise<Metadata> {
  const { gym_uuid } = await props.params;
  const [{ t, locale }, gymResult] = await Promise.all([getServerTranslation('kiosk'), fetchPublicGym(gym_uuid)]);
  const path = `/embed/gym/${gym_uuid}/leaderboard`;
  const publicGym = gymResult.status === 'ok' ? gymResult.gym : null;
  // A private/absent (or unfetchable) gym gets the generic fallback — its
  // name must not leak through metadata either.
  if (publicGym === null) {
    return createNoIndexMetadata({
      title: t('embed.metadata.leaderboardFallbackTitle'),
      description: t('embed.metadata.leaderboardFallbackDescription'),
      path,
      locale,
    });
  }
  return createNoIndexMetadata({
    title: t('embed.metadata.leaderboardTitle', { gymName: publicGym.name }),
    description: t('embed.metadata.leaderboardDescription', { gymName: publicGym.name }),
    path,
    locale,
  });
}

export default async function EmbedGymLeaderboardPage(props: EmbedGymLeaderboardRouteProps) {
  const [{ gym_uuid }, searchParams] = await Promise.all([props.params, props.searchParams]);

  const gymResult = await fetchPublicGym(gym_uuid);

  // Transient failure (backend blip): the self-healing retry screen inside
  // the embed shell (attribution bar stays up) — an embed on a gym's website
  // is as unattended as a TV, and a 404'd iframe would stay dead until a
  // visitor reloads the host page.
  if (gymResult.status === 'error') {
    return <EmbedRetryState locale={await getLocale()} />;
  }

  const publicGym = gymResult.gym;
  if (publicGym === null) {
    // Successfully resolved but nonexistent or PRIVATE — masked as not-found
    // (see fetchPublicGym).
    notFound();
  }

  // Anonymous gymBoards is server-restricted to the gym's public, LISTED
  // boards — the widget can't enumerate anything a logged-out visitor
  // couldn't. The leaderboard IS the boards, so a transient failure here
  // renders the retry screen too.
  const boardsResult = await fetchGymBoardsForEmbed(gym_uuid);
  if (boardsResult.status === 'error') {
    return <EmbedRetryState locale={await getLocale()} />;
  }

  const period = parseEmbedLeaderboardPeriod(searchParams.period);
  const { scopedBoard, scopedBoards } = resolveEmbedLeaderboardScope(boardsResult.entity, searchParams.board);

  const locale = await getLocale();

  return (
    <I18nProvider locale={locale} namespaces={['common', 'kiosk']}>
      <EmbedShell brandGym={publicGym} attributionHref={embedAttributionHref(publicGym)}>
        {/* Client side mounts React Query only — no websocket, no presence hub. */}
        <EmbedLeaderboard
          boardUuids={scopedBoards.map((board) => board.uuid)}
          scopeName={scopedBoard?.name ?? null}
          period={period}
        />
      </EmbedShell>
    </I18nProvider>
  );
}
