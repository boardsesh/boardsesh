// Server renderer shared by /kiosk/[gym_slug] and /kiosk/[gym_slug]/[kiosk_slug].
//
// Fetches the kiosk over anonymous HTTP GraphQL (revalidate 60 — the config
// poll in kiosk-reliability.tsx reloads open TVs within 5 minutes of an edit),
// seeds each board's latest climb from boardRecentClimbs (no-store), and
// server-renders the full preset grid with raster placeholders. The client
// presence hub then attaches one live subscription per board over a single
// graphql-ws connection.

import React, { cache } from 'react';
import { notFound, permanentRedirect } from 'next/navigation';
import type { Metadata } from 'next';
import { GET_GYM_KIOSK } from '@boardsesh/graphql/operations';
import type { GymKiosk, GymKioskBoard } from '@boardsesh/shared-schema';
import { getGraphQLHttpUrl } from '@/app/lib/graphql/client';
import { SSR_BACKEND_FETCH_TIMEOUT_MS } from '@/app/lib/ssr-fetch-deadline';
import { getPublicBackendHttpUrl } from '@/app/lib/backend-url';
import { resolveGymLogoDisplayUrl } from '@/app/lib/gym-logo-display-url';
import { getLocale } from '@/app/lib/i18n/get-locale';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import I18nProvider from '../providers/i18n-provider';
import { buildBoardSlotData, type BoardSlotData } from './board-slot-data';
import { buildKioskViewModel } from './kiosk-view-model';
import KioskThemeScope from './kiosk-theme-scope';
import KioskPresenceHub from './presence/kiosk-presence-hub';
import KioskHeader from './kiosk-header';
import KioskLayout from './kiosk-layout';
import KioskAttribution from './kiosk-attribution';
import KioskReliability from './kiosk-reliability';
import KioskRetryScreen from './kiosk-retry-screen';
import KioskAnalytics from './kiosk-analytics';
import BoardSlot from './board-slot/board-slot';
import LeaderboardRail from './leaderboard-rail/leaderboard-rail';
import layoutStyles from './kiosk-layout.module.css';

const KIOSK_REVALIDATE_SECONDS = 60;

/**
 * A transient failure ('error': backend down, HTTP error, GraphQL resolver
 * error) is distinguished from a genuine "no such kiosk" ('ok' with a null
 * kiosk). A TV is unattended, so only the latter may 404 — a blip during e.g.
 * the 04:00 reload must land on the self-healing retry screen, never brick
 * the TV on a chrome-less 404 page with no reliability layer.
 */
export type GymKioskFetchResult = { status: 'ok'; kiosk: GymKiosk | null } | { status: 'error' };

/**
 * Anonymous, request-deduped (React cache) kiosk fetch shared by the page body
 * and generateMetadata. Mirrors `resolveBoardBySlug`'s transport.
 *
 * The deadline matters more here than anywhere: nobody is watching a gym TV's
 * tab to hit reload. An aborted fetch lands in the catch as 'error', which is
 * already the retry screen — so a wedged backend costs the TV a few seconds and
 * a self-healing reload instead of an indefinitely blank page.
 */
export const fetchGymKiosk = cache(async (gymSlug: string, kioskSlug: string | null): Promise<GymKioskFetchResult> => {
  try {
    const response = await fetch(getGraphQLHttpUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: GET_GYM_KIOSK, variables: { gymSlug, kioskSlug } }),
      signal: AbortSignal.timeout(SSR_BACKEND_FETCH_TIMEOUT_MS),
      next: { revalidate: KIOSK_REVALIDATE_SECONDS },
    });
    if (!response.ok) return { status: 'error' };
    const payload = (await response.json()) as {
      data?: { gymKiosk?: GymKiosk | null } | null;
      errors?: unknown[];
    };
    // GraphQL-level errors (resolver crash) are transient too — a genuine
    // not-found/not-visible resolves successfully to `gymKiosk: null`.
    if (payload.data?.gymKiosk === undefined || (payload.errors?.length ?? 0) > 0) {
      return { status: 'error' };
    }
    return { status: 'ok', kiosk: payload.data.gymKiosk };
  } catch {
    return { status: 'error' };
  }
});

export async function buildKioskMetadata(gymSlug: string, kioskSlug: string | null): Promise<Metadata> {
  const [{ t, locale }, fetchResult] = await Promise.all([
    getServerTranslation('kiosk'),
    fetchGymKiosk(gymSlug, kioskSlug),
  ]);
  const path = kioskSlug === null ? `/kiosk/${gymSlug}` : `/kiosk/${gymSlug}/${kioskSlug}`;
  const kiosk = fetchResult.status === 'ok' ? fetchResult.kiosk : null;
  if (kiosk === null) {
    return createNoIndexMetadata({
      title: t('metadata.fallbackTitle'),
      description: t('metadata.fallbackDescription'),
      path,
      locale,
    });
  }
  return createNoIndexMetadata({
    title: t('metadata.title', { gymName: kiosk.gym.name, kioskName: kiosk.name }),
    description: t('metadata.description', { gymName: kiosk.gym.name }),
    path,
    locale,
  });
}

type RenderableSlot = { board: GymKioskBoard } & BoardSlotData;

export default async function KioskPageRenderer({ gymSlug, kioskSlug }: { gymSlug: string; kioskSlug: string | null }) {
  const fetchResult = await fetchGymKiosk(gymSlug, kioskSlug);

  // Transient failure (backend blip, network outage): render the self-healing
  // retry screen instead of 404ing — a bricked 404 on an unattended TV needs a
  // human with a remote. Default-branded theme scope: the gym's branding is in
  // the payload we just failed to fetch.
  if (fetchResult.status === 'error') {
    const retryLocale = await getLocale();
    return (
      <I18nProvider locale={retryLocale} namespaces={['common', 'kiosk']}>
        <KioskThemeScope gym={{}}>
          <KioskRetryScreen />
        </KioskThemeScope>
      </I18nProvider>
    );
  }

  const kiosk = fetchResult.kiosk;
  if (kiosk === null) {
    notFound();
  }

  // The requested gym slug belonged to a merged twin: the backend resolved the
  // kiosk against the canonical gym, whose slug differs. Redirect a printed QR's
  // old URL onto the canonical one (308) — preserving the kiosk segment — instead
  // of leaving the TV on a dead slug. Never happens for a live gym.
  if (kiosk.gym.slug && kiosk.gym.slug !== gymSlug) {
    permanentRedirect(kioskSlug === null ? `/kiosk/${kiosk.gym.slug}` : `/kiosk/${kiosk.gym.slug}/${kioskSlug}`);
  }

  const locale = await getLocale();
  const { t } = await getServerTranslation('kiosk');

  const slots: RenderableSlot[] = (
    await Promise.all(
      kiosk.boards.map(async (board): Promise<RenderableSlot | null> => {
        const slotData = await buildBoardSlotData(board);
        if (slotData === null) return null;
        return { board, ...slotData };
      }),
    )
  ).filter((slot): slot is RenderableSlot => slot !== null);

  // View model over the boards that ACTUALLY render: the backend already
  // omitted dead/hidden slots, and a board-details failure above degrades the
  // same way — so the preset, the rail's scope universe, and the presence hub
  // all describe the same visible kiosk. A rail scoped to an unrenderable
  // board widens to all rendered boards inside buildKioskViewModel.
  const renderedBoards = slots.map((slot) => slot.board);
  const viewModel = buildKioskViewModel({ layout: kiosk.layout, boards: renderedBoards });
  const preset = viewModel.preset;
  const distinctBoardIds = Array.from(new Set(renderedBoards.map((board) => board.boardId)));

  const rail =
    viewModel.leaderboard === null ? null : (
      <LeaderboardRail leaderboard={viewModel.leaderboard} boards={viewModel.boards} />
    );

  return (
    <I18nProvider locale={locale} namespaces={['common', 'kiosk']}>
      <KioskThemeScope gym={kiosk.gym}>
        <KioskAnalytics />
        <KioskReliability
          gymSlug={gymSlug}
          kioskSlug={kioskSlug}
          kioskUuid={kiosk.uuid}
          gymUuid={kiosk.gym.uuid}
          initialUpdatedAt={kiosk.updatedAt}
        />
        <KioskPresenceHub boardIds={distinctBoardIds}>
          <div className={layoutStyles.root}>
            <KioskHeader
              gymName={kiosk.gym.name}
              // Stored logo paths are backend-relative; resolve against the
              // BROWSER-reachable backend origin (split-domain deploys would
              // otherwise 404 the logo against the web host).
              logoUrl={resolveGymLogoDisplayUrl(kiosk.gym.logoUrl ?? null, getPublicBackendHttpUrl())}
              kioskName={kiosk.name}
              gymSlug={kiosk.gym.slug ?? null}
            />
            {preset === null ? (
              <div className={layoutStyles.setupPlaceholder}>
                <h1 className={layoutStyles.setupTitle}>{t('setup.title')}</h1>
                <p className={layoutStyles.setupBody}>{t('setup.body')}</p>
              </div>
            ) : (
              <KioskLayout preset={preset} rail={rail}>
                {slots.map((slot) => (
                  <BoardSlot
                    key={slot.board.boardUuid}
                    boardId={slot.board.boardId}
                    boardName={slot.board.name}
                    angle={slot.board.angle}
                    boardDetails={slot.boardDetails}
                    initialClimb={slot.initialClimb}
                    initialClimbImageUrl={slot.initialClimbImageUrl}
                    bareBoardImageUrl={slot.bareBoardImageUrl}
                    slug={slot.board.slug}
                    showInstallQr={viewModel.showInstallQr}
                  />
                ))}
              </KioskLayout>
            )}
          </div>
        </KioskPresenceHub>
        <KioskAttribution hasRail={rail !== null && preset !== null} />
      </KioskThemeScope>
    </I18nProvider>
  );
}
