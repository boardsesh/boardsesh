import React from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import Image from 'next/image';
import { PersonOutlined } from '@mui/icons-material';
import BackButton from '@/app/components/back-button';
import LocaleLink from '@/app/components/i18n/locale-link';
import StaticClimbList from '@/app/components/climb-list/static-climb-list';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { getLocale } from '@/app/lib/i18n/get-locale';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { buildVersionedOgImagePath } from '@/app/lib/seo/og';
import { createBoardContentPageMetadata, createNoIndexMetadata } from '@/app/lib/seo/metadata';
import { getSetterOgSummary } from '@/app/lib/seo/dynamic-og-data';
import {
  frontDoorPagePath,
  isFrontDoorPageOutOfRange,
  isIndexableFrontDoorPage,
  NOINDEX_FOLLOW,
  parseFrontDoorPage,
  resolveListPageIndexation,
  type ListPageSearchParams,
} from '@/app/lib/seo/list-page-robots';
import { formatBoardDisplayName } from '@/app/lib/string-utils';
import { buildCanonicalClimbListUrl } from '@/app/lib/url-utils';
import { themeTokens } from '@/app/theme/theme-config';
import { getSetterPageView, setterPageHasCrawlableClimb } from './setter-page-view';
import SetterFollowIsland from './setter-follow-island';
import SetterJsonLd from './setter-json-ld';
import SetterSeoFragment from './setter-seo-fragment';
import SetterShareButton from './setter-share-button';

type SetterPageProps = {
  params: Promise<{ setter_username: string }>;
  searchParams: Promise<ListPageSearchParams>;
};

const containerSx = { maxWidth: 900, margin: '0 auto', padding: `${themeTokens.spacing[4]}px` };

const actionsSx = { display: 'flex', alignItems: 'center', justifyContent: 'space-between' };

const heroSx = {
  display: 'flex',
  alignItems: 'center',
  gap: `${themeTokens.spacing[4]}px`,
  margin: `${themeTokens.spacing[5]}px 0`,
};

const avatarSx = {
  position: 'relative',
  width: themeTokens.spacing[16],
  height: themeTokens.spacing[16],
  borderRadius: '50%',
  overflow: 'hidden',
  flexShrink: 0,
  backgroundColor: 'var(--color-primary-fill)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const metaSx = {
  display: 'flex',
  gap: `${themeTokens.spacing[3]}px`,
  flexWrap: 'wrap',
  color: 'var(--neutral-400)',
};

const chipsSx = { display: 'flex', gap: `${themeTokens.spacing[2]}px`, flexWrap: 'wrap', my: 1 };

const paginationSx = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: `${themeTokens.spacing[4]}px`,
  margin: `${themeTokens.spacing[6]}px 0`,
};

const relatedLinksSx = {
  display: 'flex',
  flexDirection: 'column',
  gap: `${themeTokens.spacing[2]}px`,
  margin: `${themeTokens.spacing[5]}px 0`,
};

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
    if (!summary) {
      return createNoIndexMetadata({
        title: t('metadata.setter.fallbackTitle'),
        description: t('metadata.setter.fallbackDescription'),
        path: cleanPath,
        locale,
        imagePath: null,
      });
    }

    const displayName = summary.displayName;
    const { path, robots } = resolveListPageIndexation({ cleanPath, page, searchParams: resolvedSearchParams });
    // The shared doctrine cannot see this one: a setter every one of whose
    // climbs sits on a configuration `resolveClimbSitemapGroups` does not
    // resolve renders an `<h1>`, fifty board images and NOT ONE crawlable climb
    // link. That is 22,490 of the 91,946 setters who answer 200 on the dev
    // image. `/sitemaps/setters` already refuses to submit them (linkable AND
    // ≥3 climbs); this stops the ones a share link or an OG card surfaces from
    // being indexed as content either.
    const linklessPage = !hasCrawlableClimb;

    return createBoardContentPageMetadata({
      title: t('metadata.setter.title', { name: displayName }),
      description: t('metadata.setter.description', { name: displayName }),
      path,
      locale,
      robots: robots ?? (linklessPage ? NOINDEX_FOLLOW : undefined),
      openGraphType: 'profile',
      imagePath: buildVersionedOgImagePath('/api/og/setter', { username }, summary.version),
      imageAlt: t('metadata.setter.ogAlt', { name: displayName }),
    });
  } catch {
    // The lookup failing is not evidence the setter exists, so keep the error
    // page out of the index — it previously emitted no canonical at all.
    return createNoIndexMetadata({
      title: t('metadata.setter.fallbackTitle'),
      description: t('metadata.setter.fallbackDescription'),
      path: cleanPath,
      locale,
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
  const { t } = await getServerTranslation('profile');

  // The SAME resolution `generateMetadata` read, memoised for this request, so
  // the robots directive and the rendered links cannot describe different pages.
  const view = await getSetterPageView(username, page);
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
  const primaryGroup = links.primaryGroup;
  const firstLinkedClimb = setterData.climbs.find((climb) => !links.unlinkedClimbUuids.has(climb.uuid));
  // `fallbackBoardDetails` IS the primary group's board when there is a primary
  // group, so this reuses the resolution the link builder already did rather
  // than repeating it — and `getBoardDetailsForBoard` throws, which would take
  // the whole page down for a related link.
  const boardListPath =
    primaryGroup && firstLinkedClimb && links.fallbackBoardDetails
      ? buildCanonicalClimbListUrl(links.fallbackBoardDetails, firstLinkedClimb.angle)
      : null;

  const basePath = `/setter/${encodeURIComponent(username)}`;

  return (
    <I18nProvider locale={locale} namespaces={['profile', 'common']}>
      <Box component="main" sx={containerSx}>
        <SetterJsonLd
          username={username}
          displayName={setterData.displayName}
          climbs={setterData.climbs}
          boardDetailsByClimb={links.boardDetailsByClimb}
          unlinkedClimbUuids={links.unlinkedClimbUuids}
          page={page}
          locale={locale}
        />

        <Box sx={actionsSx}>
          <BackButton fallbackUrl="/" />
          <SetterShareButton username={username} displayName={setterData.displayName} />
        </Box>

        <SetterSeoFragment
          displayName={setterData.displayName}
          boardTypes={setterData.boardTypes}
          climbCount={setterData.climbCount}
        />

        <Box sx={heroSx}>
          <Box sx={avatarSx}>
            {setterData.avatarUrl ? (
              <Image src={setterData.avatarUrl} alt={setterData.displayName} fill style={{ objectFit: 'cover' }} />
            ) : (
              <PersonOutlined />
            )}
          </Box>
          <Box>
            <Box sx={metaSx}>
              <span>
                {setterData.climbCount} {t('setter.climb', { count: setterData.climbCount })}
              </span>
            </Box>
            <Box sx={chipsSx}>
              {setterData.boardTypes.map((boardType) => (
                <Chip key={boardType} label={formatBoardDisplayName(boardType)} size="small" variant="outlined" />
              ))}
            </Box>
            <SetterFollowIsland username={username} initialFollowerCount={setterData.followerCount} />
          </Box>
        </Box>

        <Typography variant="h5" component="h2">
          {t('setter.climbsHeading', { name: setterData.displayName })}
        </Typography>

        {links.fallbackBoardDetails ? (
          <StaticClimbList
            climbs={setterData.climbs}
            boardDetails={links.fallbackBoardDetails}
            boardDetailsByClimb={links.boardDetailsByClimb}
            unlinkedClimbUuids={links.unlinkedClimbUuids}
            virtualize={false}
            initialImageCount={6}
            emptyState={<Typography component="p">{t('setter.empty')}</Typography>}
          />
        ) : (
          <Typography component="p">{t('setter.empty')}</Typography>
        )}

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
          {boardListPath && primaryGroup && (
            <LocaleLink href={boardListPath}>
              {t('setter.browseBoard', { boardName: formatBoardDisplayName(primaryGroup.boardType) })}
            </LocaleLink>
          )}
          <LocaleLink href="/playlists">{t('setter.browsePlaylists')}</LocaleLink>
        </Box>
      </Box>
    </I18nProvider>
  );
}
