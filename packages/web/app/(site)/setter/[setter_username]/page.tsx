import { buildClimbThumbnailCrops } from '@/app/lib/climb-thumbnail-crop.server';
import React from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import Image from 'next/image';
import { boardTypeProperty } from '@boardsesh/analytics';
import FrontDoorInstall from '@/app/components/climb-front-door/front-door-install';
import PhoneQrCard from '@/app/components/climb-front-door/phone-qr-card';
import QrLandingTracker from '@/app/components/climb-front-door/qr-landing-tracker';
import { setterQrUrl } from '@/app/lib/gym-attribution';
import { getStoreButtonLabels } from '@/app/lib/store-button-labels.server';
import BackButton from '@/app/components/back-button';
import LocaleLink from '@/app/components/i18n/locale-link';
import StaticClimbList from '@/app/components/climb-list/static-climb-list';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { getLocale } from '@/app/lib/i18n/get-locale';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { boardTypeLabel } from '@boardsesh/board-constants';
import { createBoardContentPageMetadata } from '@/app/lib/seo/metadata';
import { getSetterOgSummary, type SetterOgSummary } from '@/app/lib/seo/dynamic-og-data';
import { buildOgContentVersion, buildOgFamilyImageUrl } from '@/app/lib/seo/og-family';
import { buildSetterSearchCopy, joinDescriptionSentences } from '@/app/lib/seo/search-description';
import {
  frontDoorPagePath,
  isFrontDoorPageOutOfRange,
  isIndexableFrontDoorPage,
  NOINDEX_FOLLOW,
  parseFrontDoorPage,
  resolveListPageIndexation,
  type ListPageSearchParams,
} from '@/app/lib/seo/list-page-robots';
import { themeTokens } from '@/app/theme/theme-config';
import {
  getSetterPageView,
  setterPageHasCrawlableClimb,
  type SetterPageView,
} from '@/app/setter/[setter_username]/setter-page-view';
import SetterFollowIsland from '@/app/setter/[setter_username]/setter-follow-island';
import SetterJsonLd from '@/app/setter/[setter_username]/setter-json-ld';
import { PageSection, PageShell } from '@/app/components/ui/page-shell';
import SetterShareButton from '@/app/setter/[setter_username]/setter-share-button';
import SetterMostSent from '@/app/setter/[setter_username]/setter-most-sent';
import { selectMostSentClimbs } from '@/app/setter/[setter_username]/setter-most-sent-picks';
import { resolveSetterBoardLinks } from '@/app/setter/[setter_username]/setter-board-links';
import { buildSetterStatsLine, setterBoardLabel } from '@/app/setter/[setter_username]/setter-stats-line';

type SetterPageProps = {
  params: Promise<{ setter_username: string }>;
  searchParams: Promise<ListPageSearchParams>;
};

const actionsSx = { display: 'flex', alignItems: 'center', justifyContent: 'space-between' };

// 104px beside a 44px heading, 68px beside the 32px one a phone gets.
const AVATAR_SIZE = { xs: 68, md: 104 } as const;

const avatarSx = {
  position: 'relative',
  width: AVATAR_SIZE,
  height: AVATAR_SIZE,
  borderRadius: '50%',
  overflow: 'hidden',
  flexShrink: 0,
  backgroundColor: 'var(--semantic-surface-elevated)',
  boxShadow: 'inset 0 0 0 1px var(--border-subtle)',
  display: 'grid',
  placeItems: 'center',
  color: 'var(--neutral-900)',
  fontFamily: 'var(--font-display), sans-serif',
  fontSize: { xs: 30, md: 46 },
  fontWeight: themeTokens.typography.fontWeight.bold,
  letterSpacing: '-0.02em',
};

const heroActionsSx = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: `${themeTokens.spacing[3]}px`,
  marginTop: `${themeTokens.spacing[4]}px`,
};

// A phone gets the store buttons; from md (900px), where the page is read on a
// laptop, the QR card takes their place, with its own store pair. One store
// block per screen, split by CSS alone, because the HTML is the same for every
// reader.
const phoneInstallSx = { display: { xs: 'block', md: 'none' } };
const desktopQrSx = { display: { xs: 'none', md: 'block' }, width: '100%' };

const boardsAndFollowSx = {
  display: 'flex',
  alignItems: 'center',
  gap: `${themeTokens.spacing[2]}px`,
  flexWrap: 'wrap',
};

// A board chip with no list to open is a label, so it takes the hairline, not
// the control border. 44px tall either way, the same height as the filter
// chips, so the linked and plain chips line up and a link is a full target.
const boardChipSx = {
  height: 44,
  borderRadius: 'var(--border-radius-full)',
  fontWeight: themeTokens.typography.fontWeight.semibold,
  borderColor: 'var(--separator)',
};

// One that opens the board's list looks like the control it is: violet label
// on `--control-border`, the boundary every interactive outline uses, and a
// 2px ring on keyboard focus rather than MUI's faint tint alone.
const linkedBoardChipSx = {
  ...boardChipSx,
  borderColor: 'var(--control-border)',
  color: 'var(--color-primary)',
  '&:hover': { borderColor: 'var(--color-primary)' },
  '&.Mui-focusVisible, &:focus-visible': {
    outline: '2px solid var(--color-primary)',
    outlineOffset: 2,
  },
};

const navigationLinkSx = {
  display: 'inline-flex',
  alignItems: 'center',
  minWidth: 44,
  minHeight: 44,
  maxWidth: '100%',
  overflowWrap: 'anywhere' as const,
};

const paginationSx = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: `${themeTokens.spacing[4]}px`,
  margin: `${themeTokens.spacing[6]}px 0`,
  '& > a': navigationLinkSx,
};

const relatedLinksSx = {
  display: 'flex',
  flexDirection: 'column',
  gap: `${themeTokens.spacing[2]}px`,
  margin: `${themeTokens.spacing[5]}px 0`,
  '& > a': navigationLinkSx,
};

/**
 * The setter's send total for the line under their name, or 0 when it is not
 * known. The same `cache()` entry `generateMetadata` read, so the head and the
 * body cost one request between them; a failure here costs the line its send
 * count and nothing else.
 */
async function readSetterSendTotal(username: string): Promise<number> {
  try {
    return (await getSetterOgSummary(username))?.totalAscents ?? 0;
  } catch {
    return 0;
  }
}

/** Below this many sends the card's hero is the climb count, and so is the share title. */
const SETTER_SENDS_HERO_MIN = 10;

type SetterTranslate = Awaited<ReturnType<typeof getServerTranslation>>['t'];

/**
 * One page of the setter's climbs, most sent first. Null when that read fails,
 * which costs the head its counts and the card its climb, and nothing else.
 */
async function readSetterPageView(username: string, page: number): Promise<SetterPageView | null> {
  try {
    return await getSetterPageView(username, page);
  } catch {
    return null;
  }
}

/** What a chat app shows above the card: the setter's send total, as the card's hero does. */
function buildSetterShareCopy(
  summary: SetterOgSummary,
  firstPage: SetterPageView | null,
  locale: string,
  t: SetterTranslate,
): { ogTitle: string; ogDescription: string } {
  const numberFormat = new Intl.NumberFormat(locale);
  const topClimb = firstPage?.data.climbs[0] ?? null;
  const climbCount = firstPage?.data.climbCount ?? null;
  const name = summary.displayName;

  if (summary.totalAscents >= SETTER_SENDS_HERO_MIN) {
    const sends = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(
      summary.totalAscents,
    );
    const sentences = [
      climbCount === null
        ? null
        : t('metadata.setter.ogSetCount', { count: climbCount, climbs: numberFormat.format(climbCount) }),
      topClimb
        ? t('metadata.setter.ogMostSent', {
            climb: topClimb.name,
            count: topClimb.ascensionist_count,
            sends: numberFormat.format(topClimb.ascensionist_count),
          })
        : null,
      t('metadata.setter.ogPickOne'),
    ];
    return {
      ogTitle: t('metadata.setter.ogTitleSends', { name, sends }),
      ogDescription: joinDescriptionSentences(sentences, locale),
    };
  }

  const boards = new Intl.ListFormat(locale, { type: 'conjunction' }).format(
    (firstPage?.data.boardTypes ?? []).map(boardTypeLabel),
  );
  const sentences = [
    boards ? t('metadata.setter.ogOnBoards', { boards }) : null,
    topClimb ? t('metadata.setter.ogMostSentSoFar', { climb: topClimb.name }) : null,
    t('metadata.setter.ogGoGetOnIt'),
  ];
  return {
    ogTitle:
      climbCount === null
        ? t('metadata.setter.title', { name })
        : t('metadata.setter.ogTitleSetCount', { name, count: climbCount, climbs: numberFormat.format(climbCount) }),
    ogDescription: joinDescriptionSentences(sentences, locale),
  };
}

/**
 * `getSetterOgSummary` returning null is the whole 404 story for metadata: the
 * query LEFT JOINs onto a seed row, so before it could be null this page
 * answered 200 with an indexable title for literally any string in the path —
 * a soft-404 farm on a route linked from every climb front door.
 */
export async function generateMetadata({ params, searchParams }: SetterPageProps): Promise<Metadata> {
  const [{ setter_username: username }, resolvedSearchParams] = await Promise.all([params, searchParams]);
  // `locale` is load-bearing: without it every /es, /fr and /de setter page
  // canonicalises onto its en-US twin and de-indexes the localised tree.
  const { t, locale } = await getServerTranslation('profile');
  // Encoded once, never decoded: Next has already decoded the dynamic segment
  // (`getRouteMatcher` runs `decodeURIComponent` on every non-repeat group
  // before params reach the segment), so decoding again turns a setter named
  // `50%` into an unhandled `URIError` — a 500 where a 404 belongs — and
  // silently rewrites `abc%2541` into `abcA`, a canonical naming somebody else.
  const cleanPath = `/setter/${encodeURIComponent(username)}`;

  // The page body 404s past the hard ceiling before it queries anything, and the
  // head has to agree: without this, a crawler walking `?page=50000` still costs
  // one setter-page query per guess through `setterPageHasCrawlableClimb`.
  //
  // `notFound()` rather than noindex metadata, because metadata built here is
  // discarded — the body 404s on the identical condition — and two readers of
  // one condition emitting different signals is how they drift apart.
  if (isFrontDoorPageOutOfRange(resolvedSearchParams.page)) notFound();

  try {
    const page = parseFrontDoorPage(resolvedSearchParams.page);

    // Started together, not one after the other. The second read is not
    // conditional on the first in any way that saves a query: the page body
    // resolves `getSetterPageView` on every request, the 404 included, so
    // returning early below only moves that query later into the same request
    // rather than avoiding it. Awaiting them in sequence bought nothing and
    // cost the head a second serial round trip on every cold request.
    //
    // Safe as a `Promise.all`: `setterPageHasCrawlableClimb` swallows its own
    // failures, so only `getSetterOgSummary` can reject, and the `catch` below
    // is what handles it.
    const [summary, hasCrawlableClimb] = await Promise.all([
      getSetterOgSummary(username),
      setterPageHasCrawlableClimb(username, page),
    ]);

    // Noindex metadata rather than `notFound()`, and the asymmetry with the
    // page-range check above is deliberate: that check reads the URL, this one
    // reads a query. The body 404s on its own read of the same rule
    // (`getSetterPageView` → `getSetterPageData`) and a 404 discards this
    // metadata entirely, so a crawler sees one signal either way. Leaving the
    // 404 to the body means the two queries disagreeing costs a noindexed 200
    // on a setter who does have visible climbs, rather than a 404 on one.
    //
    // They agree today because both spell one rule — `is_listed = true AND
    // is_draft = false` on `board_climbs` — as the `has_visible_climb` EXISTS
    // in `getSetterOgSummary` and as `visibleSetterClimbsWhere` in
    // `server-setter-data.ts`. Change one and change the other.
    //
    // Through the board-content helper, not `createNoIndexMetadata`: that one
    // delegates to `createPageMetadata` and so ships a self-canonical plus the
    // full four-locale `alternates.languages` map. On a surface of ~32,000
    // setter URLs that republishes exactly the hreflang cluster this page
    // exists to collapse, on the branch a crawler is most likely to hit.
    if (!summary) {
      return createBoardContentPageMetadata({
        title: t('metadata.setter.fallbackTitle'),
        description: t('metadata.setter.fallbackDescription'),
        path: cleanPath,
        locale,
        robots: NOINDEX_FOLLOW,
        imagePath: null,
      });
    }

    const displayName = summary.displayName;
    // This page's view is already read for this request: `setterPageHasCrawlableClimb`
    // above read it, and the page body reads it again, all one `cache()` entry.
    // The card's climb comes from page one only; a later page skips it rather
    // than paying for a second read.
    const pageView = await readSetterPageView(username, page);
    const firstPage = page === 1 ? pageView : null;
    const { ogTitle, ogDescription } = buildSetterShareCopy(summary, firstPage, locale, t);
    // The climb count and boards are the setter's own, the same on every page.
    const { title, description } = buildSetterSearchCopy({
      t,
      locale,
      name: displayName,
      climbCount: pageView?.data.climbCount ?? null,
      boardTypes: pageView?.data.boardTypes ?? [],
      totalAscents: summary.totalAscents,
      page,
    });
    const topClimb = firstPage?.data.climbs[0];
    // A setter with no visible climb returned above, which is the card's own gate.
    const imageUrl = buildOgFamilyImageUrl(
      'setter',
      { username },
      buildOgContentVersion(summary.version, topClimb?.uuid ?? null, topClimb?.ascensionist_count ?? null),
    );
    const { path, robots } = resolveListPageIndexation({ cleanPath, page, searchParams: resolvedSearchParams });
    // The shared doctrine cannot see this one: a setter every one of whose
    // climbs sits on a configuration `resolveClimbSitemapGroups` does not
    // resolve renders an `<h1>`, fifty board images and NOT ONE crawlable climb
    // link. That is 22,490 of the 91,946 setters who answer 200 on the dev
    // image. `/sitemaps/setters` refuses to submit them too — and it now checks
    // the same PAGE, not just the catalogue: its floor is "≥3 linkable climbs
    // anywhere" AND "≥1 of them inside page one's top-50-by-ascents slice",
    // which is the condition this line reads. They disagreed until #4579, and
    // the shard advertised URLs that landed here and declared themselves
    // unindexable. This still earns its place: a share link or an OG card can
    // surface a page the shard never submitted.
    const linklessPage = !hasCrawlableClimb;

    return createBoardContentPageMetadata({
      title,
      description,
      path,
      locale,
      robots: robots ?? (linklessPage ? NOINDEX_FOLLOW : undefined),
      ogTitle,
      ogDescription,
      openGraphType: 'profile',
      ...(imageUrl ? { imagePath: imageUrl } : {}),
      imageAlt: t('metadata.setter.ogAlt', { name: displayName }),
    });
  } catch {
    // The lookup failing is not evidence the setter exists, so keep the error
    // page out of the index — it previously emitted no canonical at all. Same
    // helper as the branch above, for the same hreflang reason.
    return createBoardContentPageMetadata({
      title: t('metadata.setter.fallbackTitle'),
      description: t('metadata.setter.fallbackDescription'),
      path: cleanPath,
      locale,
      robots: NOINDEX_FOLLOW,
      imagePath: null,
    });
  }
}

/**
 * The setter front door, server-rendered.
 *
 * Everything a crawler reads — the `<h1>`, the summary paragraph, every climb
 * anchor, the pagination and the JSON-LD — is in the first server HTML. It used
 * to be none of it: the page rendered a `'use client'` component that fetched
 * over GraphQL from a `useEffect` with `loading` initialised true, so the whole
 * server `<body>` stripped to ~365 characters of chrome with zero `<h1>` and
 * zero links.
 *
 * Two client islands survive, both viewer-specific and neither part of the
 * crawlable payload: the follow button and the share control.
 */
export default async function SetterProfilePage({ params, searchParams }: SetterPageProps) {
  const [{ setter_username: username }, resolvedSearchParams] = await Promise.all([params, searchParams]);

  // Past the hard ceiling there is no page to render, and 404ing before the
  // query means a crawler walking made-up page numbers costs one not-found
  // rather than one deep `OFFSET` each.
  if (isFrontDoorPageOutOfRange(resolvedSearchParams.page)) return notFound();

  const page = parseFrontDoorPage(resolvedSearchParams.page);
  const locale = await getLocale();
  const [{ t }, { t: tClimbs }, storeButtonLabels] = await Promise.all([
    getServerTranslation('profile'),
    getServerTranslation('climbs'),
    getStoreButtonLabels(),
  ]);

  // The SAME resolution `generateMetadata` read, memoised for this request, so
  // the robots directive and the rendered links cannot describe different pages.
  // The send total is the head's `getSetterOgSummary` call too, with the same
  // argument, so `cache()` answers it without a second request.
  const [view, totalAscents] = await Promise.all([getSetterPageView(username, page), readSetterSendTotal(username)]);
  // A real 404, not a 200 shell. `getSetterPageData` returns null only when the
  // setter has no publicly visible climb at all — the same rule the metadata
  // above noindexes on, so the two surfaces cannot disagree.
  if (!view) return notFound();
  const setterData = view.data;

  // A `?page` inside the range but past this setter's climbs is a thin page
  // reachable only by guessing — nothing links past the last page with content,
  // and the sitemap submits only the bare path. Across tens of thousands of
  // setter pages that is a duplicate-content farm on demand, so it 404s rather
  // than serving an indexable, self-canonical empty list.
  if (page > 1 && setterData.climbs.length === 0) return notFound();

  const links = view.links;
  const boardLinks = resolveSetterBoardLinks(setterData.boardTypes, setterData.climbs, links, (boardType) =>
    setterBoardLabel(boardType, t),
  );
  // The related link at the foot names the board most of this page's linked
  // climbs sit on, and goes where that board's chip goes.
  const primaryBoardType = links.primaryGroup?.boardType;
  const primaryBoardLink = boardLinks.find((boardLink) => boardLink.boardType === primaryBoardType && boardLink.href);
  const mostSentPicks = selectMostSentClimbs({
    climbs: setterData.climbs,
    links,
    page,
    climbCount: setterData.climbCount,
  });

  const basePath = `/setter/${encodeURIComponent(username)}`;
  // The board most of this page's climbs sit on, for the scan event; never the setter.
  const scanBoardType = boardTypeProperty(primaryBoardType ?? setterData.boardTypes[0]).boardType;

  return (
    <I18nProvider locale={locale} namespaces={['profile', 'common', 'climbs', 'settings']}>
      {/* `wide`: both widths share the 1200px frame, but `prose` caps each
          direct child at 720px (`.prose > *`), and the art cards and the
          two-column rows need the full frame. */}
      <PageShell
        width="wide"
        title={t('setter.seoHeading', { name: setterData.displayName })}
        lead={buildSetterStatsLine({
          t,
          locale,
          climbCount: setterData.climbCount,
          boardTypes: setterData.boardTypes,
          totalAscents,
        })}
        breadcrumb={
          <Box sx={actionsSx}>
            <BackButton fallbackUrl="/" />
            <SetterShareButton username={username} displayName={setterData.displayName} />
          </Box>
        }
        media={
          // Decorative: the name is the heading right beside it.
          <Box sx={avatarSx} aria-hidden="true">
            {setterData.avatarUrl ? (
              <Image src={setterData.avatarUrl} alt="" fill sizes="104px" style={{ objectFit: 'cover' }} />
            ) : (
              // Whole characters, so a name that opens with an emoji keeps it.
              Array.from(setterData.displayName)[0]?.toUpperCase()
            )}
          </Box>
        }
        headerActions={
          <Box sx={heroActionsSx}>
            <Box sx={boardsAndFollowSx}>
              {boardLinks.map((boardLink) =>
                boardLink.href ? (
                  <Chip
                    key={boardLink.boardType}
                    clickable
                    component={LocaleLink}
                    href={boardLink.href}
                    prefetch={false}
                    aria-label={t('setter.browseBoard', { boardName: boardLink.label })}
                    label={boardLink.label}
                    variant="outlined"
                    sx={linkedBoardChipSx}
                  />
                ) : (
                  <Chip key={boardLink.boardType} label={boardLink.label} variant="outlined" sx={boardChipSx} />
                ),
              )}
              <SetterFollowIsland username={username} initialFollowerCount={setterData.followerCount} />
            </Box>
            <Box sx={phoneInstallSx}>
              <FrontDoorInstall
                placement="setter"
                helperText={t('setter.installHelper', { name: setterData.displayName })}
                labels={storeButtonLabels}
                appearance="brand"
                qrLanding="setter"
              />
            </Box>
            <Box sx={desktopQrSx}>
              <PhoneQrCard
                // Page 1, whatever page the laptop is on: the code is for
                // carrying this setter to a phone, not this page of their list.
                url={setterQrUrl(basePath, locale)}
                title={t('setter.qr.title')}
                body={tClimbs('frontDoor.qr.body')}
                imageLabel={t('setter.qr.imageLabel', { name: setterData.displayName })}
                placement="setter-qr-card"
                storeLabels={storeButtonLabels}
                qrLanding="setter"
              />
            </Box>
          </Box>
        }
      >
        {/* A phone that scanned the laptop's QR code lands here: count it once. */}
        <QrLandingTracker kind="setter" boardType={scanBoardType} />
        <SetterJsonLd
          username={username}
          displayName={setterData.displayName}
          climbs={setterData.climbs}
          boardDetailsByClimb={links.boardDetailsByClimb}
          unlinkedClimbUuids={links.unlinkedClimbUuids}
          page={page}
        />

        <SetterMostSent picks={mostSentPicks} />

        <PageSection title={t('setter.climbsHeading', { name: setterData.displayName })}>
          {links.fallbackBoardDetails ? (
            <StaticClimbList
              climbs={setterData.climbs}
              thumbnailCropsByClimb={buildClimbThumbnailCrops(
                setterData.climbs,
                (climb) => links.boardDetailsByClimb[climb.uuid] ?? links.fallbackBoardDetails,
              )}
              boardDetails={links.fallbackBoardDetails}
              boardDetailsByClimb={links.boardDetailsByClimb}
              unlinkedClimbUuids={links.unlinkedClimbUuids}
              virtualize={false}
              rowVariant="card"
              columns={2}
              showSetter={false}
              showAngle
              // The first most-sent card is the page's largest image and sits
              // in the first screen at 390px and 1440px; it takes the high
              // priority the first row thumbnail would otherwise ask for.
              prioritizeFirstRow={mostSentPicks.length === 0}
              emptyState={<Typography component="p">{t('setter.empty')}</Typography>}
            />
          ) : (
            <Typography component="p">{t('setter.empty')}</Typography>
          )}
        </PageSection>

        <Box component="nav" aria-label={t('setter.pagination.aria')} sx={paginationSx}>
          {page > 1 ? (
            <LocaleLink href={frontDoorPagePath(basePath, page - 1)} rel="prev">
              {t('setter.pagination.previous')}
            </LocaleLink>
          ) : (
            <span />
          )}
          <span>{t('setter.pagination.pageLabel', { page })}</span>
          {/*
            The walk stops at the last indexable page, exactly as the `/list`
            front door does: `noindex, follow` past the cap is an instruction to
            keep walking, so a `next` chain running on `hasMore` alone would hand
            a crawler a corridor whose per-request `OFFSET` grows without limit.
          */}
          {setterData.hasMore && isIndexableFrontDoorPage(page + 1) ? (
            <LocaleLink href={frontDoorPagePath(basePath, page + 1)} rel="next">
              {t('setter.pagination.next')}
            </LocaleLink>
          ) : (
            <span />
          )}
        </Box>

        <Box sx={relatedLinksSx}>
          {primaryBoardLink?.href ? (
            <LocaleLink href={primaryBoardLink.href}>
              {t('setter.browseBoard', { boardName: primaryBoardLink.label })}
            </LocaleLink>
          ) : null}
          <LocaleLink href="/playlists">{t('setter.browsePlaylists')}</LocaleLink>
        </Box>
      </PageShell>
    </I18nProvider>
  );
}
