// /embed/board/[board_uuid] — the live board view as an iframe widget for gym
// websites. Anonymous, cookieless, display-only; served with
// `Content-Security-Policy: frame-ancestors *` and WITHOUT X-Frame-Options
// (see next.config.mjs headers() + the middleware /embed carve-out).
//
// Recommended snippet (fixed-height design):
//   <iframe src="https://boardsesh.com/embed/board/<uuid>"
//           width="100%" height="640" title="Live board view"></iframe>
//
// Keyed by the board's immutable uuid (not its slug — slugs are user-editable
// and a rename would kill every embed pasted into a gym CMS).

import React from 'react';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getLocale } from '@/app/lib/i18n/get-locale';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { buildBoardSlotData } from '@/app/components/kiosk/board-slot-data';
import BoardSlot from '@/app/components/kiosk/board-slot/board-slot';
import KioskPresenceHub from '@/app/components/kiosk/presence/kiosk-presence-hub';
import EmbedShell from '@/app/components/kiosk/embed/embed-shell';
import EmbedRetryState from '@/app/components/kiosk/embed/embed-retry';
import {
  embedAttributionHref,
  resolveEmbedBrandGym,
  resolveEmbeddableBoard,
  type EmbeddableBoard,
} from '@/app/components/kiosk/embed/embed-access';
import { fetchBoardForEmbed, fetchGymForEmbed } from '@/app/components/kiosk/embed/embed-fetchers';

type EmbedBoardRouteProps = {
  params: Promise<{ board_uuid: string }>;
};

type EmbeddableBoardResult = { status: 'error' } | { status: 'ok'; board: EmbeddableBoard | null };

/**
 * SECURITY GATE — the `board(boardUuid)` resolver serves PRIVATE boards fully
 * enriched to anonymous callers, so this page (and its metadata) must decide
 * visibility itself: not public, or missing a presence-channel id, or not
 * found at all → `board: null` (the page notFound()s). See
 * resolveEmbeddableBoard for the rule; embed-access.test.ts pins it. A
 * transient fetch failure stays distinguishable ('error' → retry screen).
 */
async function fetchEmbeddableBoard(boardUuid: string): Promise<EmbeddableBoardResult> {
  const fetchResult = await fetchBoardForEmbed(boardUuid);
  if (fetchResult.status === 'error') return { status: 'error' };
  return { status: 'ok', board: resolveEmbeddableBoard(fetchResult.entity) };
}

export async function generateMetadata(props: EmbedBoardRouteProps): Promise<Metadata> {
  const { board_uuid } = await props.params;
  const [{ t, locale }, boardResult] = await Promise.all([
    getServerTranslation('kiosk'),
    fetchEmbeddableBoard(board_uuid),
  ]);
  const path = `/embed/board/${board_uuid}`;
  const board = boardResult.status === 'ok' ? boardResult.board : null;
  // A non-embeddable (or unfetchable) board gets the generic fallback — a
  // private board's name must not leak through metadata either.
  if (board === null) {
    return createNoIndexMetadata({
      title: t('embed.metadata.boardFallbackTitle'),
      description: t('embed.metadata.boardFallbackDescription'),
      path,
      locale,
    });
  }
  return createNoIndexMetadata({
    title: t('embed.metadata.boardTitle', { boardName: board.name }),
    description: t('embed.metadata.boardDescription', { boardName: board.name }),
    path,
    locale,
  });
}

export default async function EmbedBoardPage(props: EmbedBoardRouteProps) {
  const { board_uuid } = await props.params;

  const boardResult = await fetchEmbeddableBoard(board_uuid);

  // Transient failure (backend blip): the self-healing retry screen inside
  // the embed shell (attribution bar stays up) — an embed on a gym's website
  // is as unattended as a TV, and a 404'd iframe would stay dead until a
  // visitor reloads the host page.
  if (boardResult.status === 'error') {
    return <EmbedRetryState locale={await getLocale()} />;
  }

  const board = boardResult.board;
  if (board === null) {
    // Successfully resolved but nonexistent, PRIVATE, or without a presence
    // id — all masked as not-found (see fetchEmbeddableBoard).
    notFound();
  }

  // Branding rides along ONLY for a public gym; a private/absent gym renders
  // the unbranded default-dark shell (its name/logo/colours must not leak).
  // A TRANSIENT gym-fetch failure also degrades to unbranded rather than
  // blocking the board view — branding is cosmetic, the wall is the widget.
  const gymResult = board.gymUuid ? await fetchGymForEmbed(board.gymUuid) : null;
  const brandGym = gymResult !== null && gymResult.status === 'ok' ? resolveEmbedBrandGym(gymResult.entity) : null;

  const slotData = await buildBoardSlotData({
    boardId: board.boardId,
    boardUuid: board.uuid,
    boardType: board.boardType,
    layoutId: board.layoutId,
    sizeId: board.sizeId,
    setIds: board.setIds,
  });
  if (slotData === null) {
    // Board config resolves to no renderable layout — deterministic, not
    // transient: nothing to embed.
    notFound();
  }

  const locale = await getLocale();

  return (
    <I18nProvider locale={locale} namespaces={['common', 'kiosk']}>
      <EmbedShell brandGym={brandGym} attributionHref={embedAttributionHref(brandGym)}>
        <KioskPresenceHub boardIds={[board.boardId]} boardUuids={{ [board.boardId]: board.uuid }}>
          <BoardSlot
            boardId={board.boardId}
            boardName={board.name}
            slug={board.slug}
            angle={board.angle}
            boardDetails={slotData.boardDetails}
            initialClimb={slotData.initialClimb}
            initialClimbImageUrl={slotData.initialClimbImageUrl}
            bareBoardImageUrl={slotData.bareBoardImageUrl}
            // Standalone embed widget: display-only, no kiosk layout and no
            // manage toggle, so the per-board install QR stays off here (the
            // QR is a kiosk-surface feature driven by the layout's
            // showInstallQr). Keeps embeds identical to before this feature.
            showInstallQr={false}
          />
        </KioskPresenceHub>
      </EmbedShell>
    </I18nProvider>
  );
}
