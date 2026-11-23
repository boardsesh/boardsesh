'use client';

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import { visuallyHidden } from '@mui/utils';
import type { SimilarClimb } from '@boardsesh/shared-schema';
import BoardImageLayers from '@/app/components/board-renderer/board-image-layers';
import GradeTile from '@/app/components/climb-front-door/grade-tile';
import LocaleLink from '@/app/components/i18n/locale-link';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { formatSends, type TranslateSends } from '@/app/lib/format-climb-stats';
import { formatFontGrade, formatVGrade } from '@/app/lib/grade-colors';
import { climbGradeForSearch } from '@/app/lib/seo/climb-display';
import { getBoardImageDetailsForBoard } from '@/app/lib/board-image-details';
import { resolveRenderBoard } from '@boardsesh/board-config/resolve-render-board';
import { getDefaultBoardConfig, getDefaultClimbViewPath } from '@/app/lib/default-board-configs';
import {
  SIMILAR_CLIMBS_QUERY,
  type SimilarClimbsResponse,
  type SimilarClimbsVariables,
} from '@boardsesh/graphql/operations/new-climb-feed';
import type { BoardImageDetails, BoardName } from '@/app/lib/types';
import type { ClimbPreview } from '@/app/lib/data/front-door-data.server';
import {
  constructBoardSlugViewUrl,
  constructClimbViewUrlWithSlugs,
  tryConstructSlugViewUrl,
} from '@/app/lib/url-utils';
import styles from './similar-climbs-list.module.css';

type SimilarClimbsListProps = {
  boardType: BoardName;
  /** Preserve the physical wall on compatible climb links. */
  boardSlug?: string;
  layoutId: number;
  threshold?: number;
  limit?: number;
  emptyMessage?: string;
  /** Viewer angle. Passed through to the resolver so each candidate's
   *  grade/quality/ascents reflect the angle the viewer is currently on
   *  rather than the candidate's own saved angle. */
  angle?: number;
  /** Viewer board configuration (the wall the user is currently looking at).
   *  Drives two things:
   *  1. Compatibility check — a similar climb is greyed-out when its
   *     `compatibleSizeIds` doesn't include `viewerBoardDetails.size_id`.
   *  2. Thumbnail rendering — compatible climbs are drawn on the viewer's
   *     exact wall (matches what they'll see when they activate it).
   *     Incompatible climbs fall back to the layout's default config (the
   *     biggest reasonable board for the layout) so the user can still see
   *     where the climb's holds actually are. */
  viewerBoardDetails?: BoardImageDetails;
  /** When true, the underlying query is run. Defaults to true; the playview
   *  drawer wires this to the collapsible-section's lazy/open state. */
  enabled?: boolean;
  /** Server-fetched candidates. Seeds React Query so the FIRST render — the
   *  one the crawler reads — already carries real anchors and the client does
   *  not refetch what the server just resolved. The climb front door passes
   *  it; the in-app callers don't and keep the client fetch. */
  initialClimbs?: SimilarClimb[];
  /**
   * Prose to render instead of the spinner while the first fetch is in flight.
   *
   * Only the climb front door passes it, and only when its server-side read
   * came back `unavailable` (#4968). That page is indexed, so the section may
   * not server-render as a bare spinner — a crawler reads the loading state as
   * the page's final content. Everywhere else the list opens behind an
   * interaction, where a spinner is the right thing and nobody indexes it.
   */
  pendingMessage?: string;
} & ({ climbUuid: string; frames?: never } | { climbUuid?: never; frames: string });

export default function SimilarClimbsList({
  boardType,
  boardSlug,
  layoutId,
  threshold = 0.5,
  limit = 10,
  emptyMessage,
  angle,
  viewerBoardDetails,
  enabled = true,
  initialClimbs,
  pendingMessage,
  climbUuid,
  frames,
}: SimilarClimbsListProps) {
  const { t } = useTranslation('climbs');
  const variables = useMemo<SimilarClimbsVariables>(
    () => ({
      input: {
        boardType,
        layoutId,
        threshold,
        limit,
        ...(angle != null ? { angle } : {}),
        ...(climbUuid ? { climbUuid } : { frames }),
      },
    }),
    [boardType, layoutId, threshold, limit, angle, climbUuid, frames],
  );

  const queryKey = useMemo(
    () => ['similarClimbs', boardType, layoutId, threshold, limit, angle ?? null, climbUuid ?? '', frames ?? ''],
    [boardType, layoutId, threshold, limit, angle, climbUuid, frames],
  );

  const { data, isLoading, isError } = useQuery<SimilarClimb[]>({
    queryKey,
    queryFn: async () => {
      const client = createGraphQLHttpClient();
      const response = await client.request<SimilarClimbsResponse, SimilarClimbsVariables>(
        SIMILAR_CLIMBS_QUERY,
        variables,
      );
      return response.similarClimbs;
    },
    enabled,
    staleTime: 5 * 60 * 1000,
    initialData: initialClimbs,
    // Pins the seed's freshness explicitly rather than relying on the default.
    // The contract that matters is "a seeded query is fresh": if it were stamped
    // `dataUpdatedAt = 0`, `Date.now() - 0` would beat any staleTime and the
    // client would refetch the moment the front door hydrates — re-running a
    // resolver rate-limited 30/min against the web server's single IP, which is
    // exactly what the server-side cache in `front-door-data.server.ts` exists
    // to avoid. query-core 5.101.4 already defaults `dataUpdatedAt` to
    // `Date.now()` when `initialData` is present (`getDefaultState`, query.js),
    // so today this is belt-and-braces; `similar-climbs-ssr.test.tsx` pins the
    // freshness itself rather than the mechanism.
    initialDataUpdatedAt: initialClimbs ? Date.now() : undefined,
  });

  if (!enabled) return null;

  if (isLoading) {
    if (pendingMessage) {
      return (
        <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
          {pendingMessage}
        </Typography>
      );
    }
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
        <CircularProgress size={24} />
      </Box>
    );
  }

  if (isError) {
    return (
      <Typography variant="body2" color="error" sx={{ py: 2 }}>
        {t('similarClimbs.loadError')}
      </Typography>
    );
  }

  const climbs = data ?? [];
  if (climbs.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
        {emptyMessage ?? t('similarClimbs.emptyDefault')}
      </Typography>
    );
  }

  return (
    <ClimbPreviewRows
      climbs={climbs}
      boardType={boardType}
      boardSlug={boardSlug}
      viewerBoardDetails={viewerBoardDetails}
    />
  );
}

export function ClimbPreviewRows({
  climbs,
  boardType,
  boardSlug,
  viewerBoardDetails,
}: {
  climbs: ClimbPreview[];
  boardType: BoardName;
  boardSlug?: string;
  viewerBoardDetails?: BoardImageDetails;
}) {
  const sizeId = viewerBoardDetails?.size_id;

  // Partition the server-side similarity-ranked list into compatible-first,
  // incompatible-last, preserving the similarity order within each group.
  // Incompatible climbs stay visible (greyed) — surfacing them is useful
  // for shared playlists / multi-board owners — but they shouldn't push
  // climbs the reader can pull on today down the list.
  const isCompatible = (climb: ClimbPreview): boolean =>
    sizeId == null || climb.compatibleSizeIds.length === 0 || climb.compatibleSizeIds.includes(sizeId);
  const orderedClimbs = [...climbs.filter(isCompatible), ...climbs.filter((c) => !isCompatible(c))];

  return (
    <Box component="ul" className={styles.rows}>
      {orderedClimbs.map((climb) => {
        const compatible = isCompatible(climb);
        return (
          <SimilarClimbRow
            key={climb.uuid}
            boardSlug={compatible ? boardSlug : undefined}
            climb={climb}
            boardType={boardType}
            // When the climb fits on the viewer's wall, render the
            // thumbnail at the viewer's exact size + sets so the
            // preview matches what they'll see on their board. When
            // it doesn't fit, pass undefined and let the row fall
            // back to getDefaultBoardConfig (biggest reasonable config
            // for the layout) so the reader can still see the climb's
            // full footprint.
            viewerBoardDetails={compatible ? viewerBoardDetails : undefined}
            compatible={compatible}
          />
        );
      })}
    </Box>
  );
}

type SimilarClimbRowProps = {
  climb: ClimbPreview;
  boardSlug?: string;
  boardType: BoardName;
  /** When set, render the thumbnail on the viewer's exact wall config
   *  (size + sets) rather than the layout's default. Only passed for
   *  compatible climbs — incompatible climbs need the bigger default
   *  config to show the holds that extend past the viewer's wall. */
  viewerBoardDetails: BoardImageDetails | undefined;
  /** When false, the row's content is greyed out. Driven by the parent's sizeId
   *  vs `climb.compatibleSizeIds` — the climb won't physically fit on the
   *  viewer's wall, but the link still resolves on the layout default. */
  compatible: boolean;
};

function SimilarClimbRow({ climb, boardType, boardSlug, viewerBoardDetails, compatible }: SimilarClimbRowProps) {
  const { t } = useTranslation('climbs');
  const angle = climb.angle ?? 0;
  const difficulty = climb.difficultyName ?? null;

  // Compatible climb: render at the viewer's exact wall config so the
  // thumbnail matches what they'll see on their board. Incompatible:
  // fall back to the layout's default (biggest reasonable) config so the
  // climb's full footprint is visible even though the user can't load it.
  const boardDetails = useMemo<BoardImageDetails | null>(() => {
    if (viewerBoardDetails && viewerBoardDetails.layout_id === climb.layoutId) {
      return viewerBoardDetails;
    }
    // Woods sizes number holds from different origins, so the default (12x12)
    // would draw an 8x10-only climb on the wrong holds: pick a size it fits.
    const config =
      boardType === 'woods' && climb.compatibleSizeIds.length > 0
        ? resolveRenderBoard({
            boardType,
            climbLayoutId: climb.layoutId,
            compatibleSizeIds: climb.compatibleSizeIds,
          })
        : getDefaultBoardConfig(boardType, climb.layoutId);
    if (!config) return null;
    try {
      return getBoardImageDetailsForBoard({
        board_name: boardType,
        layout_id: climb.layoutId,
        size_id: config.sizeId,
        set_ids: config.setIds,
      });
    } catch {
      return null;
    }
  }, [boardType, climb.layoutId, climb.compatibleSizeIds, viewerBoardDetails]);

  // Fallback link path for when the queue isn't available — preserves the
  // original navigation behaviour for the duplicate-resolution drawer.
  const climbViewPath = useMemo(() => {
    if (boardSlug) {
      return constructBoardSlugViewUrl(encodeURIComponent(boardSlug), angle, climb.uuid, climb.name || undefined);
    }
    // Id-aware first: boardDetails can be the viewer's REAL board (not just the
    // layout default), so a shadowed size (Kilter 12x12 without kickboard) must
    // not be slugged from names onto the other board's bare slug.
    if (boardDetails) {
      const idAwarePath = tryConstructSlugViewUrl(
        boardType,
        boardDetails.layout_id,
        boardDetails.size_id,
        boardDetails.set_ids,
        angle,
        climb.uuid,
        climb.name || undefined,
      );
      if (idAwarePath) return idAwarePath;
    }
    if (boardDetails?.layout_name && boardDetails.size_name && boardDetails.set_names) {
      return constructClimbViewUrlWithSlugs(
        boardType,
        boardDetails.layout_name,
        boardDetails.size_name,
        boardDetails.size_description,
        boardDetails.set_names,
        angle,
        climb.uuid,
        climb.name || undefined,
      );
    }
    return getDefaultClimbViewPath(boardType, climb.layoutId, angle, climb.uuid, climb.name || undefined);
  }, [boardSlug, boardType, climb.layoutId, angle, climb.uuid, climb.name, boardDetails]);

  // Dim the thumbnail when the climb is incompatible with the viewer's wall
  // size: the link still resolves (on the layout default config), it just isn't
  // a climb they can pull on today. Only the picture: the name, setter and grade
  // stay at full contrast, so the row still reads at 4.5:1.
  const dimClass = compatible ? '' : ` ${styles.dimmed}`;
  const fontGrade = formatFontGrade(difficulty);
  const hasVGrade = Boolean(formatVGrade(difficulty, boardType));

  const rowInner = (
    <>
      <Box className={`${styles.thumb}${dimClass}`}>
        {boardDetails ? (
          <BoardImageLayers
            boardDetails={boardDetails}
            frames={climb.frames ?? undefined}
            mirrored={false}
            thumbnail
            style={{ width: '100%', height: '100%' }}
          />
        ) : null}
      </Box>
      <Box className={styles.text}>
        <Box className={styles.name} title={climb.name || undefined}>
          {climb.name || t('similarClimbs.untitledClimb')}
          {/* The tile is a picture of the grade; this is the grade in words, once. */}
          {difficulty ? (
            <Box component="span" sx={visuallyHidden}>
              {t('frontDoor.hero.gradeForSearch', { grade: climbGradeForSearch(difficulty) })}
            </Box>
          ) : null}
        </Box>
        <Box className={styles.byline}>{formatByline(climb, t)}</Box>
      </Box>
      <Box className={styles.grade}>
        {hasVGrade ? (
          <>
            <GradeTile difficulty={difficulty} boardName={boardType} size="compact" />
            {fontGrade ? (
              <Box component="span" aria-hidden="true" className={styles.fontGrade}>
                {fontGrade}
              </Box>
            ) : null}
          </>
        ) : difficulty ? (
          <Box component="span" aria-hidden="true" className={styles.fontGrade}>
            {climbGradeForSearch(difficulty)}
          </Box>
        ) : null}
      </Box>
    </>
  );

  // One rendering path: a real `<a href>` to the climb's canonical view URL,
  // the whole row its hit area. The queue-activation button and the actions
  // ellipsis moved to the app; this list serves the SSR front door, where every
  // row has to be a crawlable link.
  if (climbViewPath) {
    return (
      <Box component="li" className={styles.item}>
        <LocaleLink href={climbViewPath} className={styles.row}>
          {rowInner}
        </LocaleLink>
      </Box>
    );
  }

  return (
    <Box component="li" className={styles.item}>
      <Box className={styles.row}>{rowInner}</Box>
    </Box>
  );
}

/**
 * Compose the "setter · ★N · Y sends" line shown under the climb name.
 * Skips any segment that's missing data — most user-created climbs have no
 * quality rating or ascent count yet, so we don't want to show stale zeros.
 */
function formatByline(climb: ClimbPreview, t: TranslateSends): string {
  const parts: string[] = [];
  if (climb.setterUsername) parts.push(climb.setterUsername);
  if (typeof climb.qualityAverage === 'number' && climb.qualityAverage > 0) {
    parts.push(`★${climb.qualityAverage.toFixed(1)}`);
  }
  if (typeof climb.ascensionistCount === 'number' && climb.ascensionistCount > 0) {
    parts.push(formatSends(climb.ascensionistCount, t));
  }
  return parts.join(' · ');
}
