'use client';

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import type { SimilarClimb } from '@boardsesh/shared-schema';
import BoardImageLayers from '@/app/components/board-renderer/board-image-layers';
import BoardCanvasRenderer from '@/app/components/board-renderer/board-canvas-renderer';
import { useCanvasRendererReady } from '@/app/lib/board-render-worker/worker-manager';
import LocaleLink from '@/app/components/i18n/locale-link';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { formatSends, type TranslateSends } from '@/app/lib/format-climb-stats';
import { useGradeFormat } from '@/app/hooks/use-grade-format';
import { useIsDarkMode } from '@/app/hooks/use-is-dark-mode';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import { getDefaultBoardConfig, getDefaultClimbViewPath } from '@/app/lib/default-board-configs';
import {
  SIMILAR_CLIMBS_QUERY,
  type SimilarClimbsResponse,
  type SimilarClimbsVariables,
} from '@boardsesh/graphql/operations/new-climb-feed';
import type { BoardDetails, BoardName } from '@/app/lib/types';
import { constructClimbViewUrlWithSlugs, tryConstructSlugViewUrl } from '@/app/lib/url-utils';
import styles from './similar-climbs-list.module.css';

type SimilarClimbsListProps = {
  boardType: BoardName;
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
  viewerBoardDetails?: BoardDetails;
  /** When true, the underlying query is run. Defaults to true; the playview
   *  drawer wires this to the collapsible-section's lazy/open state. */
  enabled?: boolean;
  /** Server-fetched candidates. Seeds React Query so the FIRST render — the
   *  one the crawler reads — already carries real anchors and the client does
   *  not refetch what the server just resolved. The climb front door passes
   *  it; the in-app callers don't and keep the client fetch. */
  initialClimbs?: SimilarClimb[];
} & ({ climbUuid: string; frames?: never } | { climbUuid?: never; frames: string });

export default function SimilarClimbsList({
  boardType,
  layoutId,
  threshold = 0.5,
  limit = 10,
  emptyMessage,
  angle,
  viewerBoardDetails,
  enabled = true,
  initialClimbs,
  climbUuid,
  frames,
}: SimilarClimbsListProps) {
  const sizeId = viewerBoardDetails?.size_id;
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

  // Partition the server-side similarity-ranked list into compatible-first,
  // incompatible-last, preserving the similarity order within each group.
  // Incompatible climbs stay visible (greyed) — surfacing them is useful
  // for shared playlists / multi-board owners — but they shouldn't push
  // tappable matches off the right edge of the horizontal scroll.
  const isCompatible = (climb: SimilarClimb): boolean =>
    sizeId == null || climb.compatibleSizeIds.length === 0 || climb.compatibleSizeIds.includes(sizeId);
  const orderedClimbs = [...climbs.filter(isCompatible), ...climbs.filter((c) => !isCompatible(c))];

  return (
    <div className={styles.scroller}>
      {orderedClimbs.map((climb) => {
        const compatible = isCompatible(climb);
        return (
          <SimilarClimbCard
            key={climb.uuid}
            climb={climb}
            boardType={boardType}
            // When the climb fits on the viewer's wall, render the
            // thumbnail at the viewer's exact size + sets so the
            // preview matches what they'll see on their board. When
            // it doesn't fit, pass undefined and let the card fall
            // back to getDefaultBoardConfig (biggest reasonable config
            // for the layout) so the user can still see the climb's
            // full footprint.
            viewerBoardDetails={compatible ? viewerBoardDetails : undefined}
            compatible={compatible}
          />
        );
      })}
    </div>
  );
}

type SimilarClimbCardProps = {
  climb: SimilarClimb;
  boardType: BoardName;
  /** When set, render the thumbnail on the viewer's exact wall config
   *  (size + sets) rather than the layout's default. Only passed for
   *  compatible climbs — incompatible climbs need the bigger default
   *  config to show the holds that extend past the viewer's wall. */
  viewerBoardDetails: BoardDetails | undefined;
  /** When false, the card body is greyed out. Driven by the parent's sizeId
   *  vs `climb.compatibleSizeIds` — the climb won't physically fit on the
   *  viewer's wall, but the link still resolves on the layout default. */
  compatible: boolean;
};

function SimilarClimbCard({ climb, boardType, viewerBoardDetails, compatible }: SimilarClimbCardProps) {
  const { t } = useTranslation('climbs');
  const canvasReady = useCanvasRendererReady();
  const isDark = useIsDarkMode();
  const { formatGrade, getGradeColor } = useGradeFormat();
  const angle = climb.angle ?? 0;
  // Format and colour the grade using the same hook the main climb-title
  // uses, so the slider respects the user's Font vs V-grade preference.
  const formattedGrade = formatGrade(climb.difficultyName ?? undefined);
  const gradeColor = getGradeColor(climb.difficultyName ?? undefined, isDark);

  // Compatible climb: render at the viewer's exact wall config so the
  // thumbnail matches what they'll see on their board. Incompatible:
  // fall back to the layout's default (biggest reasonable) config so the
  // climb's full footprint is visible even though the user can't load it.
  const boardDetails = useMemo<BoardDetails | null>(() => {
    if (viewerBoardDetails && viewerBoardDetails.layout_id === climb.layoutId) {
      return viewerBoardDetails;
    }
    const config = getDefaultBoardConfig(boardType, climb.layoutId);
    if (!config) return null;
    try {
      return getBoardDetailsForBoard({
        board_name: boardType,
        layout_id: climb.layoutId,
        size_id: config.sizeId,
        set_ids: config.setIds,
      });
    } catch {
      return null;
    }
  }, [boardType, climb.layoutId, viewerBoardDetails]);

  // Fallback link path for when the queue isn't available — preserves the
  // original navigation behaviour for the duplicate-resolution drawer.
  const climbViewPath = useMemo(() => {
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
  }, [boardType, climb.layoutId, angle, climb.uuid, climb.name, boardDetails]);

  // Dim the thumbnail / name / byline when the climb is incompatible with the
  // viewer's wall size: the link still resolves (on the layout default config),
  // it just isn't a climb they can pull on today.
  const dimClass = compatible ? '' : ` ${styles.dimmed}`;
  const thumbnail = boardDetails ? (
    <div className={`${styles.boardSquare}${dimClass}`}>
      {canvasReady && climb.frames ? (
        <BoardCanvasRenderer
          boardDetails={boardDetails}
          frames={climb.frames}
          mirrored={false}
          thumbnail
          style={{ width: '100%', height: '100%' }}
        />
      ) : (
        <BoardImageLayers
          boardDetails={boardDetails}
          frames={climb.frames ?? undefined}
          mirrored={false}
          thumbnail
          style={{ width: '100%', height: '100%' }}
        />
      )}
    </div>
  ) : (
    <div className={`${styles.boardSquare}${dimClass}`} />
  );

  const cardInner = (
    <>
      {thumbnail}
      <div className={`${styles.nameRow}${dimClass}`}>
        <div className={styles.name} title={climb.name || undefined}>
          {climb.name || t('similarClimbs.untitledClimb')}
        </div>
        {formattedGrade ? (
          // Set the grade colour as a CSS custom property so the module CSS
          // owns the rule. The cast through `as React.CSSProperties` allows
          // the custom property without complaint from React's typed style.
          <span
            className={styles.grade}
            style={gradeColor ? ({ '--grade-color': gradeColor } as React.CSSProperties) : undefined}
          >
            {formattedGrade}
          </span>
        ) : null}
      </div>
      <div className={`${styles.byline}${dimClass}`}>{formatByline(climb, t)}</div>
    </>
  );

  // One rendering path: a real `<a href>` to the climb's canonical view URL.
  // The queue-activation button and the actions ellipsis moved to the app —
  // this component now serves the SSR front door, where every card has to be
  // a crawlable link.
  if (climbViewPath) {
    return (
      <div className={styles.cardWrapper}>
        <LocaleLink href={climbViewPath} className={styles.card}>
          {cardInner}
        </LocaleLink>
      </div>
    );
  }

  return <div className={`${styles.card} ${styles.cardDisabled}`}>{cardInner}</div>;
}

/**
 * Compose the "setter · ★N · Y sends" byline shown under the climb name.
 * Skips any segment that's missing data — most user-created climbs have no
 * quality rating or ascent count yet, so we don't want to show stale zeros.
 */
function formatByline(climb: SimilarClimb, t: TranslateSends): string {
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
