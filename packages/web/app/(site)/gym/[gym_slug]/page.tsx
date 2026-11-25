import React, { cache } from 'react';
import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { localeHref } from '@/app/lib/i18n/locale-href';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import Divider from '@mui/material/Divider';
import LocationOnOutlined from '@mui/icons-material/LocationOnOutlined';
import FitnessCenterOutlined from '@mui/icons-material/FitnessCenterOutlined';
import PersonOutlined from '@mui/icons-material/PersonOutlined';
import PeopleOutlined from '@mui/icons-material/PeopleOutlined';
import ChatBubbleOutlined from '@mui/icons-material/ChatBubbleOutlineOutlined';
import ScheduleOutlined from '@mui/icons-material/ScheduleOutlined';
import type { Gym, MyGymClaim, UserBoard } from '@boardsesh/shared-schema';
import {
  GET_GYM_PENDING_CLAIM,
  GET_GYM_BOARDS_FOR_LISTING,
  GET_GYM_KIOSK,
  GET_GYM_SPRAY_WALLS,
  type GetGymPendingClaimQueryResponse,
  type GetGymBoardsQueryResponse,
  type GetGymSprayWallsQueryResponse,
  type GymSprayWallListing,
  type GetGymKioskQueryResponse,
  type GymKioskOperationResult,
} from '@boardsesh/graphql/operations';
import { disambiguateBoardSubtitles, stripGymNamePrefix } from '@boardsesh/board-config';
import { getBoardDiscovery } from '@/app/lib/server-board-discovery';
import GymPopularClimbPreview, {
  type GymPopularPreviewBoard,
} from '@/app/components/gym-entity/gym-popular-climb-preview';
import { gymMapsUrl } from '@/app/lib/gym-maps-url';
import { constructBoardSlugListUrl } from '@/app/lib/url-utils';
import { boardTypeLabel, CATALOGUE_BOARD_TYPES } from '@boardsesh/board-constants';
import { parseGymQrLanding } from '@boardsesh/analytics';
import { gymRedirectAttributionQuery } from '@/app/lib/gym-attribution';
import { getServerAuthToken } from '@/app/lib/auth/server-auth';
import { executeAuthenticatedGraphQL } from '@/app/lib/graphql/server-graphql';
import { getLocale } from '@/app/lib/i18n/get-locale';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getStoreButtonLabels } from '@/app/lib/store-button-labels.server';
import { createPageMetadata, createNoIndexMetadata, absoluteUrl } from '@/app/lib/seo/metadata';
import { gymIsIndexableVenue } from '@/app/lib/seo/gym-index-eligibility';
import { buildOgContentVersion, buildOgFamilyImageUrl } from '@/app/lib/seo/og-family';
import { JsonLd } from '@/app/lib/seo/json-ld';
import { safeExternalHref } from '@/app/lib/safe-external-url';
import { themeTokens } from '@/app/theme/theme-config';
import I18nProvider from '@/app/components/providers/i18n-provider';
import LocaleLink from '@/app/components/i18n/locale-link';
import { quietLinkSx } from '@/app/components/ui/quiet-link';
import { PageShell } from '@/app/components/ui/page-shell';
import GymStatChip from '@/app/components/gym-entity/gym-stat-chip';
import CommentSection from '@/app/components/social/comment-section';
import GymPageManageButton from '@/app/gym/[gym_slug]/gym-page-manage-button';
import GymFollowButton from '@/app/gym/[gym_slug]/gym-follow-button';
import GymClaimCta from '@/app/gym/[gym_slug]/gym-claim-cta';
import GymClaimCalloutMirror from '@/app/gym/[gym_slug]/gym-claim-callout';
import GymClaimParamCleanup from '@/app/gym/[gym_slug]/gym-claim-param-cleanup';
import GymClaimPendingNotice from '@/app/gym/[gym_slug]/gym-claim-pending-notice';
import GymRunByLine from '@/app/gym/[gym_slug]/gym-run-by-line';
import {
  CLAIM_PARAM,
  gymListingStateOf,
  resolveClaimCtaVariant,
  resolveClaimSurface,
} from '@/app/gym/[gym_slug]/gym-claim-cta-logic';
import GymOwnerPrompts from '@/app/gym/[gym_slug]/gym-owner-prompts';
import GymReportDuplicateCta from '@/app/gym/[gym_slug]/gym-report-duplicate-cta';
import {
  GymReportProblemHost,
  ReportBoardButton,
  ReportGymButton,
  type GymReportBoard,
} from '@/app/gym/[gym_slug]/gym-report-problem';
import { isDirectoryReportsEnabled } from '@/app/lib/directory-reports/directory-reports-flag';
import { isDirectorySetupSuggestionsEnabled } from '@/app/lib/directory-reports/directory-setup-suggestions-flag';
import { formatHoursConfirmedDate } from '@/app/gym/[gym_slug]/gym-hours-display';
import GymPageCtaLink from '@/app/gym/[gym_slug]/gym-page-cta-link';
import GymInstallCta from '@/app/gym/[gym_slug]/gym-install-cta';
import GymQrLandingTracker from '@/app/gym/[gym_slug]/gym-qr-landing-tracker';
import styles from '@/app/gym/[gym_slug]/gym-page.module.css';
import { fetchGymBySlug, isGymViewable } from '@/app/gym/[gym_slug]/fetch-gym-by-slug';
import { getPublicBackendHttpUrl } from '@/app/lib/backend-url';
import { resolveGymLogoDisplayUrl, resolveGymPhotoDisplayUrl } from '@/app/lib/gym-logo-display-url';

type GymRouteProps = {
  params: Promise<{ gym_slug: string }>;
  // Same shape the manage route declares. Read for the QR-landing params a
  // printed poster carries (`?src=qr&medium=poster`); several later PRs of this
  // epic read their own params from it.
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

/**
 * The viewer's own claim in flight, fetched on its own so a failure degrades to
 * "no notice" instead of "no gym". `fetchGymBySlug` returning null means
 * `notFound()`, so folding this selection into that document would 404 the whole
 * page — for every gym at once — if web ever deploys ahead of the backend that
 * answers `myPendingClaim`. Only ever called for a signed-in viewer who could
 * actually hold a claim, so anonymous readers (the page's whole audience) pay
 * nothing.
 */
async function fetchMyPendingClaim(slug: string, token: string): Promise<MyGymClaim | null> {
  try {
    const response = await executeAuthenticatedGraphQL<GetGymPendingClaimQueryResponse>(
      GET_GYM_PENDING_CLAIM,
      { slug },
      token,
    );
    return response.gymBySlug?.myPendingClaim ?? null;
  } catch (error) {
    console.error('fetchMyPendingClaim failed:', error);
    return null;
  }
}

async function fetchDefaultKiosk(gymSlug: string, token: string | undefined): Promise<GymKioskOperationResult | null> {
  try {
    const response = await executeAuthenticatedGraphQL<GetGymKioskQueryResponse>(
      GET_GYM_KIOSK,
      { gymSlug, kioskSlug: null },
      token,
    );
    return response.gymKiosk ?? null;
  } catch (error) {
    console.error('fetchDefaultKiosk failed:', error);
    return null;
  }
}

/**
 * Request-deduped like `fetchGymBySlug`: `generateMetadata` reads the boards a
 * stranger sees (no token) for the share copy, and for an anonymous reader, which
 * is every crawler, that is the page body's own read.
 */
const fetchGymBoards = cache(async (gymUuid: string, token: string | undefined): Promise<UserBoard[]> => {
  try {
    const response = await executeAuthenticatedGraphQL<GetGymBoardsQueryResponse>(
      GET_GYM_BOARDS_FOR_LISTING,
      { gymUuid },
      token,
    );
    return response.gymBoards ?? [];
  } catch (error) {
    console.error('fetchGymBoards failed:', error);
    return [];
  }
});

/**
 * The gym's spray walls, as its members and the open web respectively may see them.
 *
 * Its own query and its own catch, like every other section on this page: a
 * backend that has not deployed `gymSprayWalls` yet must cost this page its wall
 * list and nothing else. Folding the selection into `fetchGymBySlug` would 404
 * the whole gym.
 *
 * `null` — not `[]` — when the ask itself failed, and the difference matters for
 * exactly one window: web deploys ahead of backend, `gymSprayWalls` is not a
 * field yet, and the caller is about to strip every spray wall out of the boards
 * section on the promise that the section below shows them instead. An empty
 * list makes that promise and breaks it, so a gym's walls disappear from the page
 * altogether until the backend catches up. `null` says "could not ask", and the
 * caller leaves the walls where they already were.
 */
async function fetchGymSprayWalls(gymUuid: string, token: string | undefined): Promise<GymSprayWallListing[] | null> {
  try {
    const response = await executeAuthenticatedGraphQL<GetGymSprayWallsQueryResponse>(
      GET_GYM_SPRAY_WALLS,
      { gymUuid },
      token,
    );
    return response.gymSprayWalls ?? [];
  } catch (error) {
    console.error('fetchGymSprayWalls failed:', error);
    return null;
  }
}

/**
 * Where a gym's spray-wall row links.
 *
 * `createSprayWall` mints a slug for every wall, so a null one is a data-integrity
 * problem rather than a case to design for — but the row still renders: a gym
 * member can see this wall, and dropping it would be a worse answer than a link to
 * the gym they are already on. The dev-only warning is the whole point of the
 * branch, so the broken row gets found instead of quietly degrading in production.
 *
 * No `?wall=` capability param, and none is needed: `gymSprayWalls` gates on
 * `viewerCanSeeSprayWallByLayout`, which has no unlisted exemption, so an unlisted
 * wall is never in this list. Every wall here is public — `/b/{slug}` resolves it
 * for anybody — or private to a gym member, whom the server recognises by their
 * session. The param is for the share link `buildSprayWallShareUrl` produces
 * (`packages/mobile/src/lib/spray/spray-share.ts`), which is the one place an
 * unlisted wall is handed out.
 */
function sprayWallHref(sprayWall: GymSprayWallListing, gymSlug: Gym['slug']): string {
  if (sprayWall.board.slug) return `/b/${sprayWall.board.slug}`;
  if (process.env.NODE_ENV === 'development') {
    console.warn(`gym spray wall ${sprayWall.uuid} has no board slug; linking to the gym instead`);
  }
  return `/gym/${gymSlug}`;
}

/**
 * Absolute, http(s)-only URL for the owner-uploaded gym photo, or null.
 *
 * Two guards, both load-bearing. safeExternalHref keeps a legacy row holding a
 * `javascript:`/`data:` value out of the `<img src>`, the JSON-LD `image` and
 * the share card — `imageUrl` was validated with a bare `z.string().url()`
 * until this feature landed, and that accepted both. And because it only
 * returns absolute URLs, a bare `/static/...` path (which would resolve
 * against www and 404 for a scraper) can never escape into metadata.
 */
function resolveGymPhotoSrc(gym: Gym): string | null {
  return safeExternalHref(resolveGymPhotoDisplayUrl(gym.imageUrl ?? null, getPublicBackendHttpUrl()));
}

type KioskTranslate = Awaited<ReturnType<typeof getServerTranslation>>['t'];

/** Search copy uses stored addresses and public boards, never inferred locations or gym.boardTypes. */
function buildGymSearchCopy(gym: Gym, boards: UserBoard[], locale: string, t: KioskTranslate) {
  // Gym has no city field. Keep the address intact instead of guessing which
  // comma-separated part is a town or reverse-geocoding its coordinates.
  const location = gym.address?.trim();
  const venue = location
    ? t('gymPage.metaTitleLocation', { gymName: gym.name, location })
    : /climb|boulder/i.test(gym.name)
      ? t('gymPage.metaTitleName', { gymName: gym.name })
      : t('gymPage.metaTitle', { gymName: gym.name });
  const publicBoards = boards.filter((board) => CATALOGUE_BOARD_TYPES.includes(board.boardType));
  const boardLabel = (board: UserBoard) => {
    const label = boardTypeLabel(board.boardType);
    return board.boardType === 'kilter' || board.boardType === 'tension' ? `${label} Board` : label;
  };
  const boardTypes = [...new Set(publicBoards.map(boardLabel))];
  const configurations = [
    ...new Set(
      publicBoards.map((board) => {
        const label = boardLabel(board);
        // Imported zeroes mean unspecified. Adjustable boards have no fixed angle.
        return board.isAngleAdjustable === false && Number.isFinite(board.angle) && board.angle !== 0
          ? t('gymPage.metaBoardAngle', { board: label, angle: board.angle })
          : label;
      }),
    ),
  ];
  const list = new Intl.ListFormat(locale, { type: 'conjunction' });
  return {
    title: boardTypes.length > 0 ? t('gymPage.metaTitleBoards', { venue, boards: list.format(boardTypes) }) : venue,
    description:
      configurations.length > 0
        ? t('gymPage.metaDescriptionBoards', { venue, boards: list.format(configurations) })
        : location
          ? t('gymPage.metaDescriptionLocation', { gymName: gym.name, location })
          : gym.description?.trim() || t('gymPage.metaDescription', { gymName: gym.name }),
  };
}

/**
 * The share card and the words above it for a public gym: its own name and the
 * boards a stranger can see on its page, the same read the card draws from. No
 * catalogue climb count is ever said about a place.
 */
async function buildGymShareCard(
  gym: Gym,
  requestedSlug: string,
  locale: string,
  t: KioskTranslate,
  boards: UserBoard[],
): Promise<{ ogTitle: string; ogDescription: string; imagePath?: string }> {
  const boardTypes = [...new Set(boards.map((board) => board.boardType))];
  const labels = boardTypes.map(boardTypeLabel);

  let generated: string;
  if (labels.length === 0) generated = t('gymPage.ogDescriptionNoBoards');
  else if (labels.length === 1) generated = t('gymPage.ogDescriptionOneType', { board: labels[0], gymName: gym.name });
  else {
    const boardList = new Intl.ListFormat(locale, { type: 'conjunction' }).format(labels);
    generated = t('gymPage.ogDescriptionManyTypes', { boards: boardList, gymName: gym.name });
  }

  const imageUrl = buildOgFamilyImageUrl(
    'place',
    // The canonical slug: a merged twin's old slug resolves to the same gym.
    { kind: 'gym', slug: gym.slug ?? requestedSlug },
    buildOgContentVersion(
      gym.name,
      gym.imageUrl ?? null,
      boards.map((board) => [board.boardType, board.angle]),
    ),
  );
  return {
    ogTitle: labels.length > 0 ? t('gymPage.ogTitle', { gymName: gym.name, boards: labels.join(' + ') }) : gym.name,
    ogDescription: gym.description?.trim() || generated,
    ...(imageUrl ? { imagePath: imageUrl } : {}),
  };
}

export async function generateMetadata(props: GymRouteProps): Promise<Metadata> {
  const { gym_slug } = await props.params;
  const token = await getServerAuthToken();
  const [gym, { t, locale }] = await Promise.all([fetchGymBySlug(gym_slug, token), getServerTranslation('kiosk')]);

  if (!isGymViewable(gym)) {
    return createNoIndexMetadata({
      title: t('metadata.fallbackTitle'),
      description: t('metadata.fallbackDescription'),
      locale,
    });
  }

  const boards = gym.isPublic ? await fetchGymBoards(gym.uuid, undefined) : [];
  const { title, description } = buildGymSearchCopy(gym, boards, locale, t);
  // `path` is the SLUG PATH ONLY — never concatenate anything from
  // `searchParams` into it. Every canonical and every hreflang alternate is
  // built from this string, so a query string here would give
  // `/gym/x?src=qr&medium=poster` its own canonical and split the page's
  // ranking signals across as many URLs as there are param combinations. Filter,
  // sort and attribution params all canonicalise to the clean base URL.
  //
  // A public gym advertises its family card, which draws the gym's own photo when
  // it has one. A private gym is only ever seen by an editor previewing it, and
  // the backend card answers 404 for it, so it keeps the generic site card.
  const canonicalSlug = gym.slug || gym_slug;
  const shareCard = gym.isPublic ? await buildGymShareCard(gym, canonicalSlug, locale, t, boards) : {};

  // A gym that isn't a public venue — a private listing, or a climber's personal
  // home wall (see `gymIsIndexableVenue`) — gets `noindex, follow` AND NO
  // `path`. Dropping `path` is the load-bearing half: `createNoIndexMetadata`
  // delegates to `createPageMetadata`, which emits `alternates.canonical` plus
  // the four-locale `hreflang` cluster whenever a path is present. A noindexed
  // page that still advertises its three locale twins republishes the very
  // cluster we are removing, and hands a crawler three more URLs each time it
  // fetches one. The page keeps serving 200 and stays crawlable on purpose —
  // `noindex` only works on a URL Google is still allowed to fetch. The sibling
  // `/gym/[gym_slug]/poster` has taken the same no-`path` route since it landed.
  if (!gymIsIndexableVenue(gym)) {
    return createNoIndexMetadata({ title, description, locale, ...shareCard });
  }

  return createPageMetadata({
    title,
    description,
    path: `/gym/${encodeURIComponent(canonicalSlug)}`,
    locale,
    ...shareCard,
  });
}

export default async function GymPage(props: GymRouteProps) {
  const [{ gym_slug }, searchParams] = await Promise.all([props.params, props.searchParams]);
  const token = await getServerAuthToken();
  const gym = await fetchGymBySlug(gym_slug, token);

  if (!isGymViewable(gym)) {
    notFound();
  }

  // The requested slug belonged to a merged twin: the backend resolved it to the
  // canonical gym, whose slug differs. Send the old URL (e.g. a printed kiosk QR)
  // to the canonical one with a 308 rather than serving the gym under a dead slug.
  //
  // The attribution params ride along, the same way the manage route carries
  // `?tab=`. A poster is laminated and stuck to a wall; the gym it names can be
  // merged into another listing a year later, and without this the 308 dropped
  // the query and every scan of that poster landed unattributed and fired no
  // `Gym QR Scanned`. `src` and `medium` are re-emitted only after the
  // contract's parser has accepted them, so a crafted `?medium=evil` cannot ride
  // through a redirect to a URL we publish.
  //
  // The campaign params (`utm_*`, `gclid`) ride along too (#6027): a gym's bio
  // link to an old slug would otherwise land looking like direct traffic.
  // Nothing else a link carries is echoed.
  //
  // The slug is percent-encoded now that a query rides behind it: a `#` in one
  // would open a fragment and swallow the params, the same case `gymQrUrl`
  // already guards when it builds the printed URL.
  const locale = await getLocale();
  if (gym.slug && gym.slug !== gym_slug) {
    permanentRedirect(
      `${localeHref(`/gym/${encodeURIComponent(gym.slug)}`, locale)}${gymRedirectAttributionQuery(searchParams)}`,
    );
  }

  // Plain awaits rather than one Promise.all: the translations resolve from the
  // same cached request instance, and this shape is what the orphaned-key check
  // can read, so the boards keys used below count as used.
  const { t } = await getServerTranslation('kiosk');
  const { t: tBoards } = await getServerTranslation('boards');
  const storeLabels = await getStoreButtonLabels();
  const [kiosk, allBoards, gymSprayWalls, discoveryBoards, reportsEnabled, setupSuggestionsEnabled] = await Promise.all(
    [
      fetchDefaultKiosk(gym_slug, token),
      fetchGymBoards(gym.uuid, token),
      fetchGymSprayWalls(gym.uuid, token),
      getBoardDiscovery({ gymUuid: gym.uuid, limit: 12 }),
      isDirectoryReportsEnabled(),
      isDirectorySetupSuggestionsEnabled(),
    ],
  );
  const sprayWalls = gymSprayWalls ?? [];
  const previewBoard = (discoveryBoards as GymPopularPreviewBoard[]).find(
    (board) =>
      board.popularClimb?.frames &&
      board.boardType !== 'spray' &&
      allBoards.some((visibleBoard) => visibleBoard.uuid === board.uuid),
  );

  // Spray walls come back in `gymBoards` too — they are ordinary `user_boards`
  // rows under the ninth board type — and they get their own section below, with
  // the photo and the hold count a wall is actually recognised by. Filtered out
  // here so the same wall is not listed twice, and BEFORE the subtitles are
  // built: those are index-aligned with the list they describe.
  //
  // Only when the wall list actually answered. `gymSprayWalls` returning null
  // means the question could not be asked at all — the deploy window where web
  // is ahead of backend — and filtering on that would take the walls out of the
  // boards section without the section below putting them back, which is worse
  // than listing them the old way for a few minutes.
  const boards = gymSprayWalls ? allBoards.filter((board) => board.boardType !== 'spray') : allBoards;

  // Two boards run by the same gym used to read identically here — "Kilter ·
  // 40°" twice, under two rows the setter had also named the same thing (issue
  // #5272). The shared labels pull them apart on whatever actually differs
  // (wall, size, layout, angle), scoped to this one gym: the heading above
  // already says which gym this is, so the rows lead with the wall instead.
  const boardSubtitles = disambiguateBoardSubtitles(boards, { scope: 'within-gym' });
  const boardRowSubtitle = (boardIndex: number): string => {
    const board = boards[boardIndex];
    return boardSubtitles[boardIndex].includes(`${board.angle}°`)
      ? boardSubtitles[boardIndex]
      : t('gymPage.boardAngle', { configuration: boardSubtitles[boardIndex], angle: board.angle });
  };

  // Stored logo/photo paths are backend-relative; resolve for the browser (also
  // keeps the JSON-LD image absolute, as schema.org expects). The logo has NO
  // imageUrl fallback: a gym photo squashed into the 72×72 contain-fitted logo
  // slot is not a logo, it's a broken-looking thumbnail — the photo has its own
  // 16:9 hero below.
  const logoSrc = resolveGymLogoDisplayUrl(gym.logoUrl ?? null, getPublicBackendHttpUrl());
  const photoSrc = resolveGymPhotoSrc(gym);
  // Render-side XSS guard: only http(s) URLs become clickable (legacy rows may
  // predate the backend's GymWebsiteSchema scheme check).
  const websiteHref = safeExternalHref(gym.website);
  const mapsHref = gymMapsUrl(gym);

  // Free-text hours, so nothing structured goes into the JSON-LD below —
  // schema.org's openingHoursSpecification wants a machine-readable model and
  // would be invalid fed a hand-typed line.
  const hoursText = gym.hours?.trim() || null;
  const hoursConfirmedDate = formatHoursConfirmedDate(gym.hoursUpdatedAt, locale);

  // A printed code carries `?src=qr&medium=…`. Anything else — a bare visit, a
  // hand-edited param, a crawler-mangled URL — parses to null and mounts nothing.
  const qrLanding = parseGymQrLanding(searchParams);

  // Which arm of the claim call-out to render — `hidden` on a gym its staff
  // run and for a signed-in viewer who already covers this gym (owner,
  // admin/editor, community leader), the anonymous arm for everyone with no
  // session. One derivation, on the server: the islands are handed the answer
  // as `viewerState` and never recompute it.
  const listingState = gymListingStateOf(gym);
  const claimCtaVariant = resolveClaimCtaVariant({
    serverCanClaim: gym.canClaim,
    serverHasSession: Boolean(token),
    listingState,
  });
  const claimParam = searchParams[CLAIM_PARAM];
  // A viewer with a claim already in flight gets the review notice instead of
  // the call-out — `canClaim` is a permission bit and stays true while their
  // claim sits in the queue. Only the signed-in arm can have one, so this is the
  // only case worth a second round trip.
  const pendingClaim = claimCtaVariant === 'signed-in' && token ? await fetchMyPendingClaim(gym_slug, token) : null;
  const claimSurface = resolveClaimSurface({
    variant: claimCtaVariant,
    gymIsPublic: gym.isPublic,
    hasPendingClaim: pendingClaim !== null,
  });
  const runByLabel =
    listingState === 'RUN_BY_GYM'
      ? tBoards('runBy.pillRunByGym')
      : listingState === 'CLIMBER_LISTED'
        ? tBoards('runBy.pillClimberListed')
        : tBoards('runBy.pillUnclaimed');

  // Report a problem (docs/product/directory-reports.md): only while the server
  // takes reports, and not for staff, who fix things from Manage gym instead.
  // Every visitor who gets it gets the same markup; sign-in is settled on tap.
  const showReportProblem = reportsEnabled && !gym.canEdit;
  const reportBoards: GymReportBoard[] = boards.map((board, boardIndex) => {
    const name = stripGymNamePrefix(board.name, gym.name);
    return {
      uuid: board.uuid,
      name,
      label: `${name} · ${boardRowSubtitle(boardIndex)}`,
      ownerId: board.ownerId ?? null,
      // The listing already carries the setup, so "Set up wrong"'s fields cost no extra read.
      setup:
        board.boardType === 'spray'
          ? null
          : {
              boardType: board.boardType,
              layoutId: board.layoutId,
              sizeId: board.sizeId,
              setIds: board.setIds,
              angle: board.angle,
              isAngleAdjustable: board.isAngleAdjustable,
            },
    };
  });

  // Prefer the real photo for search-result thumbnails; fall back to the logo.
  const structuredDataImage = photoSrc ?? logoSrc;

  // `SportsActivityLocation` is markup about a PLACE the public can climb at, so
  // it rides the same rule as the index directive rather than a bare `isPublic`
  // check: a climber's home wall is not a venue, and describing one as an
  // activity location — under a name that is usually the owner's own — is both
  // wrong structured data and the same leak in a second format.
  const jsonLd = gymIsIndexableVenue(gym)
    ? {
        '@context': 'https://schema.org',
        '@type': 'SportsActivityLocation',
        name: gym.name,
        url: absoluteUrl(`/gym/${gym_slug}`),
        ...(gym.description ? { description: gym.description } : {}),
        ...(gym.address ? { address: gym.address } : {}),
        ...(websiteHref ? { sameAs: websiteHref } : {}),
        ...(structuredDataImage ? { image: structuredDataImage } : {}),
      }
    : null;

  return (
    <I18nProvider locale={locale} namespaces={['common', 'boards', 'kiosk', 'settings']}>
      {qrLanding && <GymQrLandingTracker gymSlug={gym_slug} medium={qrLanding.medium} />}
      {jsonLd && <JsonLd data={jsonLd} />}
      {/* One dialog for the gym and every board row; the buttons below open it. */}
      {showReportProblem && (
        <GymReportProblemHost
          gym={{
            uuid: gym.uuid,
            name: gym.name,
            slug: gym.slug ?? null,
            listingState: gym.listingState ?? null,
            // The nudge lands on this page's claim call-out, so offer it only when that is what renders.
            canClaim: gym.canClaim && claimSurface.kind === 'cta',
            latitude: gym.latitude,
            longitude: gym.longitude,
          }}
          boards={reportBoards}
          setupSuggestionsEnabled={setupSuggestionsEnabled}
          storeLabels={storeLabels}
        />
      )}
      {/* PageShell owns the fixed-header clearance and the page measure, so the
          hand-rolled Container and its header offset are gone. The h1 is the
          shell's title now, which puts it above the wall shot rather than
          beside the logo — the name is what someone scanning a poster is
          looking for, and it is the first thing rendered either way. */}
      <PageShell
        width="wide"
        title={gym.name}
        headerActions={
          <GymRunByLine
            listingState={listingState}
            label={runByLabel}
            claim={claimSurface.kind === 'cta' ? { gymUuid: gym.uuid, label: tBoards('runBy.claimInline') } : null}
          />
        }
        breadcrumb={
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <MuiLink component={LocaleLink} href="/" underline="hover" sx={quietLinkSx}>
              {t('gymPage.breadcrumbHome')}
            </MuiLink>
            <Box component="span" aria-hidden="true" sx={{ color: 'var(--neutral-400)' }}>
              ›
            </Box>
            {/* The directory is how most people got here — a poster scan lands
                on this page with no other way back into the gym list. */}
            <MuiLink component={LocaleLink} href="/gyms" underline="hover" sx={quietLinkSx}>
              {t('gymPage.breadcrumbGyms')}
            </MuiLink>
          </Box>
        }
      >
        <Box className={styles.identity}>
          <Box className={styles.summary}>
            {(logoSrc || gym.address || mapsHref) && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', mb: 3 }}>
                {logoSrc && (
                  <Box
                    component="img"
                    src={logoSrc}
                    alt={gym.name}
                    sx={{
                      width: 72,
                      height: 72,
                      borderRadius: 'var(--border-radius-lg)',
                      objectFit: 'contain',
                      flexShrink: 0,
                      backgroundColor: 'var(--semantic-surface)',
                      border: '1px solid var(--separator)',
                    }}
                  />
                )}
                {mapsHref && (
                  <MuiLink
                    href={mapsHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={t('gymPage.openMaps', { gymName: gym.name })}
                    sx={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 0.5,
                      minHeight: 44,
                      overflowWrap: 'anywhere',
                    }}
                  >
                    <LocationOnOutlined sx={{ fontSize: 18 }} />
                    {gym.address?.trim() || t('gymPage.mapsLocation')}
                  </MuiLink>
                )}
              </Box>
            )}

            {gym.description && (
              <Typography variant="body1" sx={{ mb: 3, maxWidth: '68ch', color: themeTokens.neutral[700] }}>
                {gym.description}
              </Typography>
            )}

            <Box sx={{ display: 'flex', gap: 2.5, flexWrap: 'wrap', mb: 3 }}>
              {gym.boardCount > 0 && (
                <GymStatChip
                  icon={<FitnessCenterOutlined sx={{ fontSize: 18 }} />}
                  value={gym.boardCount}
                  label={tBoards('gymEntity.stats.boards', { count: gym.boardCount })}
                />
              )}
              {gym.memberCount > 0 && (
                <GymStatChip
                  icon={<PersonOutlined sx={{ fontSize: 18 }} />}
                  value={gym.memberCount}
                  label={tBoards('gymEntity.stats.members', { count: gym.memberCount })}
                />
              )}
              {gym.followerCount > 0 && (
                <GymStatChip
                  icon={<PeopleOutlined sx={{ fontSize: 18 }} />}
                  value={gym.followerCount}
                  label={tBoards('gymEntity.stats.followers', { count: gym.followerCount })}
                />
              )}
              {gym.commentCount > 0 && (
                <GymStatChip
                  icon={<ChatBubbleOutlined sx={{ fontSize: 18 }} />}
                  value={gym.commentCount}
                  label={tBoards('gymEntity.stats.comments', { count: gym.commentCount })}
                />
              )}
            </Box>

            <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mb: 3 }}>
              <GymFollowButton gymUuid={gym.uuid} ownerId={gym.ownerId} isFollowedByMe={gym.isFollowedByMe} />
              {/* Both CTAs render through a client island purely so the click is
              counted. The island keeps the same anchor and the same real href;
              the label is translated here on the server, so no i18n key moves. */}
              {kiosk && (
                <GymPageCtaLink
                  cta="kiosk"
                  gymUuid={gym.uuid}
                  href={`/kiosk/${gym_slug}`}
                  label={t('gymPage.seeOnTheWall')}
                />
              )}
              {websiteHref && (
                <GymPageCtaLink cta="website" gymUuid={gym.uuid} href={websiteHref} label={t('gymPage.visitWebsite')} />
              )}
              {gym.canEdit && <GymPageManageButton gymSlug={gym_slug} />}
            </Box>

            {/* The call-out's phone copy: above the boards below 960px, where the
                details column would put it under the boards and the install
                block. Its button asks the details copy to start the claim. */}
            {claimSurface.kind === 'cta' && (
              <GymClaimCalloutMirror
                gymUuid={gym.uuid}
                viewerState={claimSurface.viewerState}
                className={styles.claimPhone}
              />
            )}

            <Box component="section" className={styles.boards} sx={{ mb: 3 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
                <FitnessCenterOutlined sx={{ fontSize: 20, color: themeTokens.neutral[400] }} />
                <Typography
                  variant="h5"
                  component="h2"
                  sx={{
                    fontSize: { xs: 28, md: 32 },
                    lineHeight: 1.25,
                    fontWeight: themeTokens.typography.fontWeight.semibold,
                  }}
                >
                  {t('gymPage.boardsHeading')}
                </Typography>
                {boards.length > 0 && (
                  <Typography variant="body2" color="text.secondary">
                    {t('gymPage.boardCount', { count: boards.length })}
                  </Typography>
                )}
              </Box>

              {/* Together with the breadcrumb above, this keeps the page at ≥2
            crawlable internal links even for a gym with no boards or kiosk. */}
              {boards.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  {t('gymPage.noBoardsYet')}
                </Typography>
              ) : (
                <Box
                  component="ul"
                  sx={{ listStyle: 'none', p: 0, m: 0, display: 'flex', flexDirection: 'column', gap: 1 }}
                >
                  {boards.map((board, boardIndex) => (
                    <Box
                      component="li"
                      key={board.uuid}
                      sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 1 }}
                    >
                      <MuiLink
                        component={LocaleLink}
                        href={`/b/${board.slug}`}
                        underline="hover"
                        sx={{ display: 'inline-flex', alignItems: 'baseline', gap: 1, color: 'var(--color-primary)' }}
                      >
                        <Typography component="span" sx={{ fontWeight: themeTokens.typography.fontWeight.semibold }}>
                          {stripGymNamePrefix(board.name, gym.name)}
                        </Typography>
                        <Typography component="span" variant="body2" color="text.secondary">
                          {boardRowSubtitle(boardIndex)}
                        </Typography>
                      </MuiLink>
                      <MuiLink
                        component={LocaleLink}
                        href={constructBoardSlugListUrl(encodeURIComponent(board.slug), board.angle)}
                        sx={{ display: 'inline-flex', alignItems: 'center', minHeight: 44, ml: 2 }}
                      >
                        {t('gymPage.seeClimbs')}
                      </MuiLink>
                      {showReportProblem && (
                        <Box sx={{ ml: 'auto' }}>
                          <ReportBoardButton
                            gymUuid={gym.uuid}
                            boardUuid={board.uuid}
                            boardName={stripGymNamePrefix(board.name, gym.name)}
                          />
                        </Box>
                      )}
                    </Box>
                  ))}
                </Box>
              )}
            </Box>

            {previewBoard && (
              <GymPopularClimbPreview
                board={previewBoard}
                heading={t('gymPage.popularClimbHeading')}
                description={t('gymPage.popularClimbBody')}
              />
            )}

            {/* The install CTA a poster scan lands on. `gym.slug || gym_slug` is the
            canonical slug: a merged twin's URL 308s onto `gym.slug` above, and a
            slug-less legacy gym has no canonical to fall back to, so the two
            paths have to agree on one campaign string per gym.
            `||`, not `??` — `slug` is nullable AND the redirect guard above is a
            truthiness check, so an empty-string slug reaches here having skipped
            the 308. `??` would pass it straight through and name the campaign
            `gym-`, collecting every such gym's installs in one bucket. */}
            <Box sx={{ mb: 3 }}>
              <Typography
                variant="subtitle1"
                component="h2"
                sx={{ fontWeight: themeTokens.typography.fontWeight.semibold, mb: 0.5 }}
              >
                {t('gymPage.install.heading')}
              </Typography>
              <Typography variant="body2" sx={{ mb: 1.5, maxWidth: '68ch', color: themeTokens.neutral[700] }}>
                {t('gymPage.install.body', { gymName: gym.name })}
              </Typography>
              <GymInstallCta gymSlug={gym.slug || gym_slug} qrMedium={qrLanding?.medium ?? null} labels={storeLabels} />
            </Box>
          </Box>
          {/* Owner-uploaded wall/board shot. Gyms without one simply don't render
            this — no placeholder art, and no effect on ranking or visibility
            anywhere; most of the long tail will never upload a photo. */}
          {photoSrc && (
            <Box
              component="img"
              src={photoSrc}
              alt={t('gymPage.photoAlt', { gymName: gym.name })}
              className={styles.photo}
              sx={{
                width: '100%',
                aspectRatio: '16 / 9',
                objectFit: 'cover',
                borderRadius: 'var(--border-radius-lg)',
                border: '1px solid var(--separator)',
                display: 'block',
              }}
            />
          )}
        </Box>

        <Box className={styles.layout}>
          <Box component="section" className={styles.boards}>
            {sprayWalls.length > 0 && (
              <>
                <Divider sx={{ my: 4 }} />

                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
                  <Typography
                    variant="h5"
                    component="h2"
                    sx={{
                      fontSize: { xs: 28, md: 32 },
                      lineHeight: 1.25,
                      fontWeight: themeTokens.typography.fontWeight.semibold,
                    }}
                  >
                    {t('gymPage.sprayWallsHeading')}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {t('gymPage.sprayWallCount', { count: sprayWalls.length })}
                  </Typography>
                </Box>

                <Typography variant="body2" sx={{ mb: 2, maxWidth: '68ch', color: themeTokens.neutral[700] }}>
                  {t('gymPage.sprayWallsIntro')}
                </Typography>

                <Box
                  component="ul"
                  sx={{ listStyle: 'none', p: 0, m: 0, display: 'flex', flexDirection: 'column', gap: 2 }}
                >
                  {sprayWalls.map((sprayWall) => (
                    <Box component="li" key={sprayWall.uuid} sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                      {/* Only a PUBLIC wall has a photo here: `publicPhotoUrl` is the
                      copy in the world-readable bucket, and it is null for every
                      other wall. A gym member reading their gym's private wall
                      gets the name and the hold count, which is the row this
                      page is allowed to render for a photograph nobody outside
                      the gym may see. */}
                      {sprayWall.publicPhotoUrl && (
                        <Box
                          component="img"
                          src={sprayWall.publicPhotoUrl}
                          alt={t('gymPage.sprayWallPhotoAlt', { wallName: sprayWall.board.name })}
                          sx={{
                            width: 96,
                            height: 72,
                            objectFit: 'cover',
                            borderRadius: 1,
                            display: 'block',
                            flexShrink: 0,
                          }}
                        />
                      )}
                      <Box>
                        <MuiLink
                          component={LocaleLink}
                          href={sprayWallHref(sprayWall, gym.slug)}
                          underline="hover"
                          sx={{ color: 'var(--color-primary)', fontWeight: themeTokens.typography.fontWeight.semibold }}
                        >
                          {stripGymNamePrefix(sprayWall.board.name, gym.name)}
                        </MuiLink>
                        <Typography variant="body2" color="text.secondary">
                          {t('gymPage.sprayWallMeta', {
                            angle: sprayWall.board.angle,
                            holds: sprayWall.holdCount,
                          })}
                        </Typography>
                      </Box>
                    </Box>
                  ))}
                </Box>
              </>
            )}
          </Box>
          <Box className={styles.details}>
            {hoursText && (
              <Box sx={{ mb: 3 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5 }}>
                  <ScheduleOutlined sx={{ fontSize: 18, color: themeTokens.neutral[400] }} />
                  <Typography
                    variant="subtitle1"
                    component="h2"
                    sx={{ fontWeight: themeTokens.typography.fontWeight.semibold }}
                  >
                    {t('gymPage.hoursHeading')}
                  </Typography>
                </Box>
                {/* The gym types its own line breaks; keep them instead of collapsing
                a week of hours into one run-on paragraph. */}
                <Typography
                  variant="body1"
                  sx={{ whiteSpace: 'pre-line', maxWidth: '68ch', color: themeTokens.neutral[700] }}
                >
                  {hoursText}
                </Typography>
                {hoursConfirmedDate && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                    {t('gymPage.hoursConfirmed', { date: hoursConfirmedDate })}
                  </Typography>
                )}
              </Box>
            )}

            {/* Self-gating: GymOwnerPrompts renders nothing for a non-editor (or a
            fully set-up gym), so the canEdit prop stays honest instead of being
            shadowed by an always-true outer guard. */}
            <GymOwnerPrompts
              gymSlug={gym_slug}
              canEdit={gym.canEdit}
              hasBoards={boards.length > 0}
              hasHours={Boolean(hoursText)}
              hasDescription={Boolean(gym.description?.trim())}
              hasKiosk={kiosk !== null}
              hasBranding={Boolean(
                gym.logoUrl || gym.brandPrimaryColor || gym.brandAccentColor || gym.brandBackgroundColor,
              )}
            />

            {/* `viewerState` is the server's answer, taken from the request cookie
            above — reading it in the island with useSession() would report the
            pre-hydration `loading` state as signed-out on exactly the taps this
            event cares about. The `isPublic` clause is spelled out rather than
            leaning on `isGymViewable`: a private gym reaches this line only via
            its own editors, and the anonymous arm has to stay impossible there
            even if the viewability rule is loosened later. */}
            {claimSurface.kind === 'cta' ? (
              <GymClaimCta
                gymUuid={gym.uuid}
                gymName={gym.name}
                gymSlug={gym_slug}
                website={gym.website}
                canClaimByDomain={gym.canClaimByDomain}
                viewerState={claimSurface.viewerState}
                claimParam={claimParam}
                className={styles.claimDesktop}
              />
            ) : (
              /* No call-out to clear the return-from-auth param, so clear it here:
             an owner or community leader who signed in and turned out to
             already cover this gym — or an anonymous visitor on a gym someone
             already runs — would otherwise sit on a live `?claim=1`. A returning
             claimant whose claim is already queued lands here too: the notice
             replaces the dialog `?claim=1` would have re-opened. */
              <>
                {claimSurface.kind === 'pending' && pendingClaim && (
                  <GymClaimPendingNotice method={pendingClaim.method} />
                )}
                <GymClaimParamCleanup claimParam={claimParam} />
              </>
            )}

            {/* Report a problem replaces Report a duplicate ("Listed twice" is one
                of its reasons). The old island stays for as long as the flag can
                be off, so signed-in climbers keep a duplicate report either way. */}
            {showReportProblem ? (
              <ReportGymButton gymUuid={gym.uuid} />
            ) : reportsEnabled ? null : (
              <GymReportDuplicateCta
                gymUuid={gym.uuid}
                gymName={gym.name}
                latitude={gym.latitude}
                longitude={gym.longitude}
              />
            )}
          </Box>
        </Box>

        <Divider sx={{ my: 4 }} />

        {gym.commentCount > 0 ? (
          <CommentSection entityType="gym" entityId={gym.uuid} title={tBoards('gymEntity.comments.title')} />
        ) : (
          <Box component="details">
            <Box component="summary" sx={{ minHeight: 44, cursor: 'pointer' }}>
              {t('gymPage.startDiscussion')}
            </Box>
            <CommentSection entityType="gym" entityId={gym.uuid} title={tBoards('gymEntity.comments.title')} />
          </Box>
        )}

        <Box sx={{ mt: 4 }}>
          <MuiLink component={LocaleLink} href="/playlists" underline="hover" sx={{ color: 'var(--color-primary)' }}>
            {t('gymPage.explorePlaylists')}
          </MuiLink>
        </Box>
      </PageShell>
    </I18nProvider>
  );
}
