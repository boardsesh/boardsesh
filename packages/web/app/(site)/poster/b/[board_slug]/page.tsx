// Print-ready QR poster for one board (#4415): "This Spraywall is on Boardsesh".
//
// An owner prints this and tapes it next to the wall; a climber scans it and
// the wall opens in the app, or on the web with the store buttons. Three sheets
// to choose from (`?layout=`): a photo poster for a Spraywall with a published
// photo, a plain black-only poster, and four cut-out cards.
//
// WHY `/poster/b/{slug}` AND NOT `/b/{slug}/poster`: iOS universal links claim
// `/b/*` for the app, so a print link under `/b/` would open the app instead of
// this page. The AASA file excludes `/poster/*` (#6778), and the code printed on
// the sheet is the plain `/b/{slug}` link, which does open the app.
//
// Chrome-less (`/poster` in `CHROME_LESS_ROUTE_PREFIXES`): the fixed header
// would print over the sheet and the footer would push it onto page two.
//
// Who gets a poster is `boardPosterTarget` in `lib/board-poster.ts`; every
// refusal is the same 404, so this route never says whether a private board or
// an unlisted wall exists. The response is never cached anywhere
// (`isBoardPosterRequest` in middleware): it prints the board's
// visibility as of this request, and an unlisted wall's URL carries its
// capability.

import React from 'react';
import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import { boardTypeLabel } from '@boardsesh/board-constants';
import PosterPrintBar from '@/app/components/poster/poster-print-bar';
import posterStyles from '@/app/components/poster/poster-sheet.module.css';
import { resolveBoardBySlug, type ResolvedBoard } from '@/app/lib/board-slug-utils';
import {
  BOARD_POSTER_LAYOUTS,
  BOARD_POSTER_LAYOUT_PARAM,
  availableBoardPosterLayouts,
  boardPosterBackHref,
  boardPosterHref,
  boardPosterTarget,
  parseBoardPosterLayout,
  type BoardPosterLayout,
  type BoardPosterTarget,
} from '@/app/lib/board-poster';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { localeHref } from '@/app/lib/i18n/locale-href';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import { WALL_CAPABILITY_PARAM, readWallCapability } from '@/app/lib/spray/spray-visibility';
import { fetchSprayWallPageData, type SprayWallPageData } from '@/app/lib/spray/spray-wall-render-data.server';
import BoardPosterLayoutSwitch from '@/app/poster/b/[board_slug]/board-poster-layout-switch';
import {
  CardSheet,
  PhotoPoster,
  PlainPoster,
  type BoardPosterContent,
} from '@/app/poster/b/[board_slug]/board-poster-sheets';
import styles from '@/app/poster/b/[board_slug]/board-poster.module.css';

type BoardPosterSearchParams = {
  [WALL_CAPABILITY_PARAM]?: string | string[];
  [BOARD_POSTER_LAYOUT_PARAM]?: string | string[];
};

type BoardPosterRouteProps = {
  params: Promise<{ board_slug: string }>;
  searchParams: Promise<BoardPosterSearchParams>;
};

type PosterSubject = {
  board: ResolvedBoard;
  target: BoardPosterTarget;
  /** A Spraywall's published version; null for an LED board. */
  wall: SprayWallPageData | null;
};

/**
 * The board, what its poster prints, and a Spraywall's published version — or
 * `null` for every refusal. `resolveBoardBySlug` and `fetchSprayWallPageData`
 * are request-cached, so metadata and page share one round trip each.
 */
async function loadPosterSubject(boardSlug: string, wallParam: string | string[] | undefined) {
  // The capability has to reach the lookup: an anonymous caller gets no row at
  // all for an unlisted wall on the slug alone.
  const board = await resolveBoardBySlug(boardSlug, readWallCapability(wallParam));
  if (!board) return null;
  const target = boardPosterTarget(board, wallParam);
  if (!target) return null;
  if (target.kind === 'led') return { board, target, wall: null } satisfies PosterSubject;
  // Null is a wall with nothing published yet, or one the backend will not
  // hand over: the same 404 as a refusal.
  const wall = await fetchSprayWallPageData(board.uuid);
  if (!wall) return null;
  return { board, target, wall } satisfies PosterSubject;
}

/**
 * The photo the poster prints: a public wall's stable public copy when it has
 * one, otherwise the published version's presigned URL. That URL lives fifteen
 * minutes, which the wall's own pages cannot put in their CDN-cached HTML; this
 * page is never cached, and the image has loaded long before anyone prints.
 */
function posterPhotoUrl(wall: SprayWallPageData, isPublicWall: boolean): string | null {
  if (isPublicWall && wall.wall.publicPhotoUrl) return wall.wall.publicPhotoUrl;
  return wall.photo.url || null;
}

export async function generateMetadata(props: BoardPosterRouteProps): Promise<Metadata> {
  const [params, searchParams] = await Promise.all([props.params, props.searchParams]);
  const [subject, { t, locale }] = await Promise.all([
    loadPosterSubject(params.board_slug, searchParams[WALL_CAPABILITY_PARAM]),
    getServerTranslation('kiosk'),
  ]);

  // NO `path`, deliberately, as on the gym poster: `path` is what emits a
  // canonical, hreflang alternates and `og:url`, and all three contradict the
  // `noindex` beside them. A refused request is not named in the title either:
  // the title must say nothing the page would refuse to show.
  return {
    ...createNoIndexMetadata({
      title: subject ? t('boardPoster.metaTitle', { boardName: subject.board.name }) : t('boardPoster.fallbackTitle'),
      description: t('boardPoster.metaDescription'),
      locale,
    }),
    // An unlisted wall's URL holds its capability; the photo and every other
    // request this page makes must not send it on.
    referrer: 'no-referrer',
  };
}

export default async function BoardPosterPage(props: BoardPosterRouteProps) {
  const [params, searchParams] = await Promise.all([props.params, props.searchParams]);
  const wallParam = searchParams[WALL_CAPABILITY_PARAM];
  const subject = await loadPosterSubject(params.board_slug, wallParam);
  if (!subject) notFound();
  const { board, target, wall } = subject;
  const { t, locale } = await getServerTranslation('kiosk');

  // A slug reached through a merge tombstone: move the poster URL to the
  // board's own slug, keeping the capability and a known layout, and nothing
  // else the request carried.
  if (board.slug && board.slug !== params.board_slug) {
    const requestedLayout = BOARD_POSTER_LAYOUTS.find((layout) => layout === searchParams[BOARD_POSTER_LAYOUT_PARAM]);
    permanentRedirect(
      localeHref(
        boardPosterHref(board.slug, { wallCapability: target.wallCapability, layout: requestedLayout }),
        locale,
      ),
    );
  }

  const photoUrl = wall ? posterPhotoUrl(wall, board.isPublic) : null;
  const layout = parseBoardPosterLayout(searchParams[BOARD_POSTER_LAYOUT_PARAM], photoUrl !== null);

  const isSpray = target.kind === 'spray';
  const monthYear = new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric' }).format(new Date());
  const content: BoardPosterContent = {
    name: board.name,
    // A Spraywall's angle is fixed. An LED board's is printed only when it
    // cannot be changed; on an adjustable board it would be wrong half the time.
    angle: wall ? wall.wall.angle : board.isAngleAdjustable ? null : board.angle,
    place: wall ? wall.wall.gymName : (board.locationName ?? null),
    qrUrl: target.qrUrl,
    typedUrl: target.typedUrl,
    photoUrl,
    copy: {
      headline: isSpray ? t('boardPoster.spray.headline') : t('boardPoster.led.headline'),
      steps: [
        t('boardPoster.scanStep'),
        isSpray ? t('boardPoster.spray.pickStep') : t('boardPoster.led.pickStep'),
        isSpray ? t('boardPoster.spray.logStep') : t('boardPoster.led.logStep'),
      ],
      justInstalled: isSpray ? t('boardPoster.spray.justInstalled') : t('boardPoster.led.justInstalled'),
      typedUrlLabel: t('gymPage.poster.typedUrlLabel'),
      openSource: t('boardPoster.openSource'),
      printed: t('boardPoster.printedOn', { monthYear }),
      // A Spraywall poster names no board brand at all. An LED poster says which
      // hardware the app talks to, and plainly that nobody endorsed us — the
      // gym poster's wording, word for word.
      legal: isSpray
        ? null
        : {
            compatibility: t('boardPoster.led.compatibility', { boardBrand: boardTypeLabel(board.boardType) }),
            independence: t('gymPage.poster.independence'),
          },
    },
  };

  const layoutLabels: Record<BoardPosterLayout, string> = {
    photo: t('boardPoster.layouts.photo'),
    plain: t('boardPoster.layouts.plain'),
    cards: t('boardPoster.layouts.cards'),
  };
  const layoutOptions = availableBoardPosterLayouts(photoUrl !== null).map((option) => ({
    layout: option,
    label: layoutLabels[option],
    href: boardPosterHref(board.slug, { wallCapability: target.wallCapability, layout: option }),
  }));

  return (
    <div className={posterStyles.page}>
      <PosterPrintBar
        backHref={boardPosterBackHref(board.slug, target.wallCapability)}
        printLabel={t('gymPage.poster.printAction')}
        backLabel={isSpray ? t('boardPoster.spray.backAction') : t('boardPoster.led.backAction')}
      >
        <BoardPosterLayoutSwitch options={layoutOptions} selected={layout} label={t('boardPoster.layoutLabel')} />
      </PosterPrintBar>

      {/* The code on an unlisted wall's poster is its share link. Said once, on
          screen, before anyone tapes it up — never printed. */}
      {target.wallCapability && (
        <Box className={posterStyles.noPrint}>
          <Alert severity="info">{t('boardPoster.unlistedNotice')}</Alert>
        </Box>
      )}

      <div className={styles.paper}>
        {layout === 'photo' && <PhotoPoster content={content} />}
        {layout === 'plain' && <PlainPoster content={content} />}
        {layout === 'cards' && <CardSheet content={content} />}
      </div>
    </div>
  );
}
