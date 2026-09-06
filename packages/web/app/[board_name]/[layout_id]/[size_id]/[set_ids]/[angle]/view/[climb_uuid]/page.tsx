import React from 'react';
import { notFound, permanentRedirect } from 'next/navigation';
import type { BoardRouteParametersWithUuid } from '@/app/lib/types';
import { getClimb, getClimbStatsForAllAngles } from '@/app/lib/data/queries';
import { getFrontDoorBetaLinks, getFrontDoorSimilarClimbs } from '@/app/lib/data/front-door-data.server';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import {
  buildCanonicalClimbViewUrl,
  isUuidOnly,
  constructClimbViewUrlWithSlugs,
  tryConstructSlugViewUrl,
} from '@/app/lib/url-utils';
import { parseRouteParams } from '@/app/lib/url-utils.server';

import type { Metadata } from 'next';
import ClimbFrontDoor from '@/app/components/climb-front-door/climb-front-door';
import { buildOgBoardRenderUrl, buildOverlayPreloadUrls } from '@/app/components/board-renderer/util';
import { scheduleOgImageWarming } from '@/app/lib/warm-overlay-cache';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { createBoardContentPageMetadata } from '@/app/lib/seo/metadata';
import { resolveClimbDisplayName } from '@/app/lib/string-utils';
import { selectCanonicalClimbAngle } from '@/app/lib/seo/canonical-climb-angle';

export async function generateMetadata(props: { params: Promise<BoardRouteParametersWithUuid> }): Promise<Metadata> {
  const params = await props.params;
  const { t, locale } = await getServerTranslation('climbs');

  try {
    const { parsedParams } = await parseRouteParams(params);
    const boardDetails = getBoardDetailsForBoard(parsedParams);
    const [currentClimb, angleStats] = await Promise.all([
      getClimb(parsedParams),
      getClimbStatsForAllAngles(parsedParams),
    ]);
    if (!currentClimb) {
      return createBoardContentPageMetadata({
        title: t('metadata.view.fallbackTitle'),
        description: t('metadata.view.fallbackDescription'),
        locale,
        robots: { index: false, follow: true },
      });
    }

    const climbName = resolveClimbDisplayName(currentClimb.name, boardDetails.board_name);
    const climbGrade = currentClimb.difficulty || 'Unknown Grade';
    const setter = currentClimb.setter_username || 'Unknown Setter';
    const quality = currentClimb.quality_average || 0;
    const ascents = currentClimb.ascensionist_count || 0;
    // ONE builder, shared with `/b/{slug}/{angle}/view` — that is what makes
    // the two trees' canonicals provably identical (A1).
    const canonicalAngle = selectCanonicalClimbAngle({
      boardName: parsedParams.board_name,
      catalogAngle: currentClimb.catalogAngle,
      angleStats,
    });
    const climbUrl = buildCanonicalClimbViewUrl(boardDetails, canonicalAngle, parsedParams.climb_uuid, climbName);

    const ogImagePath = buildOgBoardRenderUrl(boardDetails, currentClimb.frames);

    // A climb hidden by an approved report keeps resolving — existing links and
    // logbook entries must not start 404ing — but it leaves the index. The
    // canonical stays self-referential, so this is a plain noindex rather than
    // the conflicting "noindex here, canonical there" pair.
    const isHiddenClimb = currentClimb.is_hidden === true;

    return createBoardContentPageMetadata({
      title: t('metadata.view.title', { climbName, grade: climbGrade }),
      description: t('metadata.view.description', { climbName, grade: climbGrade, setter, quality, ascents }),
      path: climbUrl,
      locale,
      imagePath: ogImagePath,
      imageAlt: t('metadata.view.imageAlt', { climbName, grade: climbGrade, boardName: boardDetails.board_name }),
      robots: isHiddenClimb ? { index: false, follow: true } : undefined,
    });
  } catch {
    return createBoardContentPageMetadata({
      title: t('metadata.view.fallbackTitle'),
      description: t('metadata.view.fallbackDescription'),
      locale,
      robots: { index: false, follow: true },
    });
  }
}

export default async function ClimbViewPage(props: { params: Promise<BoardRouteParametersWithUuid> }) {
  const params = await props.params;

  try {
    const { parsedParams, isNumericFormat } = await parseRouteParams(params);
    const needsSlugRedirect = isNumericFormat || isUuidOnly(params.climb_uuid);

    // Fetch the climb once. On the redirect path we use its name to build the
    // slug URL; on the normal path we pass it through to the SEO fragment and
    // the drawer.
    const currentClimb = await getClimb(parsedParams);
    if (!currentClimb) notFound();

    if (needsSlugRedirect) {
      const queries = await import('@/app/lib/data/queries');
      const [layouts, sizes, sets] = await Promise.all([
        Promise.resolve(queries.getLayouts(parsedParams.board_name)),
        Promise.resolve(queries.getSizes(parsedParams.board_name, parsedParams.layout_id)),
        Promise.resolve(queries.getSets(parsedParams.board_name, parsedParams.layout_id, parsedParams.size_id)),
      ]);

      const layout = layouts.find((l) => l.id === parsedParams.layout_id);
      const size = sizes.find((s) => s.id === parsedParams.size_id);
      const selectedSets = sets.filter((s) => parsedParams.set_ids.includes(s.id));

      if (!layout || !size || selectedSets.length === 0) {
        // A numeric/uuid-only URL whose layout/size/sets can't be resolved
        // doesn't correspond to a real climb on this board configuration —
        // 404 rather than silently falling through to render an empty list.
        notFound();
      }
      // Id-aware, and it has to be: a 308 is cached by the browser forever, so
      // the bare size slug the name-based builder emits would permanently pin
      // /kilter/1/27/... to size 10 — a different physical board — and disagree
      // with the canonical `generateMetadata` above builds from the same ids.
      // The name-based builder stays as the fallback for a board the static
      // tables don't carry but the queries above resolved.
      const newUrl =
        tryConstructSlugViewUrl(
          parsedParams.board_name,
          parsedParams.layout_id,
          parsedParams.size_id,
          parsedParams.set_ids,
          parsedParams.angle,
          parsedParams.climb_uuid,
          currentClimb.name,
        ) ??
        constructClimbViewUrlWithSlugs(
          parsedParams.board_name,
          layout.name,
          size.name,
          size.description,
          selectedSets.map((s) => s.name),
          parsedParams.angle,
          parsedParams.climb_uuid,
          currentClimb.name,
        );
      // `generateSlugFromText` (shared/play-view) is ASCII-only (`\w` doesn't
      // match Cyrillic/CJK/emoji), so a climb whose name is entirely
      // non-Latin slugs to '' and both builders above fall back to the bare
      // uuid — the same value this route may already have been requested
      // with. Compare against the RAW request path (not `parsedParams`, which
      // normalises slugs/ids and would never match) so we only redirect when
      // the target actually differs; otherwise `permanentRedirect(newUrl)`
      // would 308 the page to itself forever.
      const requestedPath = `/${params.board_name}/${params.layout_id}/${params.size_id}/${params.set_ids}/${params.angle}/view/${params.climb_uuid}`;
      if (newUrl !== requestedPath) {
        permanentRedirect(newUrl);
      }
    }

    const boardDetails = getBoardDetailsForBoard(parsedParams);

    const [angleStats, similarClimbs, betaLinks] = await Promise.all([
      getClimbStatsForAllAngles(parsedParams),
      getFrontDoorSimilarClimbs({
        boardType: parsedParams.board_name,
        layoutId: parsedParams.layout_id,
        climbUuid: parsedParams.climb_uuid,
        angle: parsedParams.angle,
      }),
      getFrontDoorBetaLinks({ boardType: parsedParams.board_name, climbUuid: parsedParams.climb_uuid }),
    ]);

    // The board overlay is preloaded below and fetched directly from Railway.
    // Keep only the single OG warm so a later share-card unfurl is a byte hit.
    scheduleOgImageWarming({ boardDetails, climb: currentClimb });
    const preloadUrls = buildOverlayPreloadUrls(boardDetails, currentClimb.frames, false);
    // Same name fallback `generateMetadata` used. An unnamed climb would
    // otherwise get the `-{board} Climb-` slug in its canonical and the bare
    // uuid form in the CTA — the hand-off would leave the page's own URL.
    const handoffPath = buildCanonicalClimbViewUrl(
      boardDetails,
      parsedParams.angle,
      parsedParams.climb_uuid,
      resolveClimbDisplayName(currentClimb.name, boardDetails.board_name),
    );
    const canonicalAngle = selectCanonicalClimbAngle({
      boardName: parsedParams.board_name,
      catalogAngle: currentClimb.catalogAngle,
      angleStats,
    });

    return (
      <>
        {preloadUrls.map((preloadUrl) => (
          <link key={preloadUrl} rel="preload" as="image" href={preloadUrl} fetchPriority="high" />
        ))}
        <ClimbFrontDoor
          climb={currentClimb}
          boardDetails={boardDetails}
          angle={parsedParams.angle}
          canonicalAngle={canonicalAngle}
          angleStats={angleStats}
          similarClimbs={similarClimbs}
          betaLinks={betaLinks}
          handoffPath={handoffPath}
          tree="config-tuple"
        />
      </>
    );
  } catch (error) {
    // Everything reaches the error boundary, which is a 500. Next.js internals
    // (permanentRedirect, notFound) carry a digest and get their own handling;
    // a read failure is genuinely a 5xx and must say so. This used to end in
    // `notFound()`, which meant a saturated pool or a dead database emitted a
    // 404 on an indexed climb URL — at sitemap scale, an instruction to
    // deindex. Google retries a 5xx and keeps the URL; that is the property
    // that matters here. `notFound()` above still fires for a climb that really
    // is not there.
    //
    // A digest is control flow, not a failure: `needsSlugRedirect` fires a 308
    // on every legacy/uuid-only URL and `notFound()` fires on every stale
    // sitemap entry, both routine and both high-volume on the crawl path.
    // Logging them would bury the brownout signal this catch exists to surface.
    if (!(error !== null && typeof error === 'object' && 'digest' in error)) {
      console.error('Error fetching results or climb:', error);
    }
    throw error;
  }
}
