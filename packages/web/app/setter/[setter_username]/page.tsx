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
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import { getLocale } from '@/app/lib/i18n/get-locale';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { buildVersionedOgImagePath } from '@/app/lib/seo/og';
import { createBoardContentPageMetadata, createNoIndexMetadata } from '@/app/lib/seo/metadata';
import { getSetterOgSummary } from '@/app/lib/seo/dynamic-og-data';
import {
  frontDoorPagePath,
  isFrontDoorPageOutOfRange,
  isIndexableFrontDoorPage,
  parseFrontDoorPage,
  resolveListPageIndexation,
  type ListPageSearchParams,
} from '@/app/lib/seo/list-page-robots';
import { getAllBoardConfigsOrThrow } from '@/app/lib/server-popular-configs';
import { formatBoardDisplayName } from '@/app/lib/string-utils';
import { buildCanonicalClimbListUrl } from '@/app/lib/url-utils';
import { themeTokens } from '@/app/theme/theme-config';
import { getSetterPageData } from './server-setter-data';
import { resolveSetterClimbLinks } from './setter-climb-links';
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
  const [{ setter_username }, resolvedSearchParams] = await Promise.all([params, searchParams]);
  const username = decodeURIComponent(setter_username);
  // `locale` is load-bearing: without it every /es, /fr and /de setter page
  // canonicalises onto its en-US twin and de-indexes the localised tree.
  const { t, locale } = await getServerTranslation('profile');
  // Decoded once, encoded once, so the canonical is byte-stable no matter how
  // the crawler encoded the incoming path.
  const cleanPath = `/setter/${encodeURIComponent(username)}`;

  try {
    const summary = await getSetterOgSummary(username);

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
    const { path, robots } = resolveListPageIndexation({
      cleanPath,
      page: parseFrontDoorPage(resolvedSearchParams.page),
      searchParams: resolvedSearchParams,
    });

    return createBoardContentPageMetadata({
      title: t('metadata.setter.title', { name: displayName }),
      description: t('metadata.setter.description', { name: displayName }),
      path,
      locale,
      robots,
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
  const [{ setter_username }, resolvedSearchParams] = await Promise.all([params, searchParams]);
  const username = decodeURIComponent(setter_username);

  // Past the hard ceiling there is no page to render, and 404ing before the
  // query means a crawler walking made-up page numbers costs one not-found
  // rather than one deep `OFFSET` each.
  if (isFrontDoorPageOutOfRange(resolvedSearchParams.page)) return notFound();

  const page = parseFrontDoorPage(resolvedSearchParams.page);
  const locale = await getLocale();
  const { t } = await getServerTranslation('profile');

  const setterData = await getSetterPageData(username, page);
  // A real 404, not a 200 shell. `getSetterPageData` returns null only when the
  // setter has no publicly visible climb at all — the same rule the metadata
  // above noindexes on, so the two surfaces cannot disagree.
  if (!setterData) return notFound();

  const links = resolveSetterClimbLinks(setterData.climbs, await getAllBoardConfigsOrThrow());
  const primaryGroup = links.primaryGroup;
  const firstLinkedClimb = setterData.climbs.find((climb) => !links.unlinkedClimbUuids.has(climb.uuid));
  const boardListPath =
    primaryGroup && firstLinkedClimb
      ? buildCanonicalClimbListUrl(
          getBoardDetailsForBoard({
            board_name: primaryGroup.boardType,
            layout_id: primaryGroup.layoutId,
            size_id: primaryGroup.sizeId,
            set_ids: primaryGroup.setIds,
          }),
          firstLinkedClimb.angle,
        )
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
                {setterData.followerCount} {t('setter.follower', { count: setterData.followerCount })}
              </span>
              <span>
                {setterData.climbCount} {t('setter.climb', { count: setterData.climbCount })}
              </span>
            </Box>
            <Box sx={chipsSx}>
              {setterData.boardTypes.map((boardType) => (
                <Chip key={boardType} label={formatBoardDisplayName(boardType)} size="small" variant="outlined" />
              ))}
            </Box>
            <SetterFollowIsland username={username} />
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
