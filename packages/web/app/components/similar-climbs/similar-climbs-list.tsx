'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import MoreVertOutlined from '@mui/icons-material/MoreVertOutlined';
import type { SimilarClimb } from '@boardsesh/shared-schema';
import BoardImageLayers from '@/app/components/board-renderer/board-image-layers';
import BoardCanvasRenderer from '@/app/components/board-renderer/board-canvas-renderer';
import { useCanvasRendererReady } from '@/app/lib/board-render-worker/worker-manager';
import { ClimbActionsDrawer } from '@/app/components/climb-actions';
import { useOptionalQueueActions } from '@/app/components/graphql-queue';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import LocaleLink from '@/app/components/i18n/locale-link';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { formatSends } from '@/app/lib/format-climb-stats';
import { useGradeFormat } from '@/app/hooks/use-grade-format';
import { useIsDarkMode } from '@/app/hooks/use-is-dark-mode';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import { getDefaultBoardConfig, getDefaultClimbViewPath } from '@/app/lib/default-board-configs';
import {
  SIMILAR_CLIMBS_QUERY,
  type SimilarClimbsResponse,
  type SimilarClimbsVariables,
} from '@boardsesh/graphql/operations/new-climb-feed';
import type { BoardDetails, BoardName, Climb } from '@/app/lib/types';
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
  });

  // Pulls in the queue context's setCurrentClimb. Optional because the
  // duplicate-resolution drawer mounts this component before a queue session
  // exists; in that case we fall back to a plain link click.
  const queueActions = useOptionalQueueActions();

  // Single drawer for all cards — track which climb's actions are open.
  // Avoids mounting N drawers up front and keeps the ClimbActions tree warm
  // only while the user is actually interacting with one.
  const [actionsClimb, setActionsClimb] = useState<SimilarClimb | null>(null);
  const closeActions = useCallback(() => setActionsClimb(null), []);

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
    <>
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
              // Disable the card-tap-activates path when the climb won't fit
              // on the viewer's wall. The ellipsis stays live below.
              onSetActive={
                queueActions && compatible
                  ? (c) => queueActions.setCurrentClimb(c, { playlistSuggestionSource: null })
                  : null
              }
              onOpenActions={() => setActionsClimb(climb)}
              compatible={compatible}
            />
          );
        })}
      </div>
      {actionsClimb ? (
        <SimilarClimbActionsDrawer
          climb={actionsClimb}
          boardType={boardType}
          viewerBoardDetails={viewerBoardDetails}
          onClose={closeActions}
        />
      ) : null}
    </>
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
  /** When set, card tap activates the climb in the queue instead of navigating. */
  onSetActive: ((climb: Climb) => Promise<unknown>) | null;
  onOpenActions: () => void;
  /** When false, the card body is greyed out and the tap-to-activate path
   *  is disabled. Driven by the parent's sizeId vs `climb.compatibleSizeIds`. */
  compatible: boolean;
};

function SimilarClimbCard({
  climb,
  boardType,
  viewerBoardDetails,
  onSetActive,
  onOpenActions,
  compatible,
}: SimilarClimbCardProps) {
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

  // Wrap the thumbnail content in a dim layer when the climb is incompatible
  // with the viewer's wall size. We dim the thumbnail / name / byline but
  // leave the ellipsis at full opacity (it's a sibling of the dim wrapper)
  // so the user can still open the actions menu — per the design, the climb
  // is just not directly activatable on this board.
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

  const handleEllipsisClick = useCallback(
    (event: React.MouseEvent) => {
      // Stop the card's onClick from also firing — opening the actions menu
      // should not also activate the climb.
      event.preventDefault();
      event.stopPropagation();
      onOpenActions();
    },
    [onOpenActions],
  );

  const handleCardClick = useCallback(() => {
    if (!onSetActive) return;
    void onSetActive(buildClimbStub(climb, boardType));
  }, [onSetActive, climb, boardType]);

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
      <div className={`${styles.byline}${dimClass}`}>{formatByline(climb)}</div>
    </>
  );

  // The ellipsis is rendered as a sibling of the clickable card surface
  // (not a descendant), because a <button> can't be nested inside another
  // <button> or inside an <a> per HTML spec. Skip it when we have no
  // boardDetails — the actions drawer needs them to render anything useful.
  const ellipsis = boardDetails ? (
    <IconButton
      size="small"
      onClick={handleEllipsisClick}
      aria-label={t('similarClimbs.openActions')}
      className={styles.ellipsis}
    >
      <MoreVertOutlined fontSize="small" />
    </IconButton>
  ) : null;

  // When the queue is available, the card is a button that activates the
  // climb in the play drawer (same drawer the user already has open). When
  // it isn't, fall back to navigating to the climb-view page so the user
  // can still inspect it from contexts outside a session (e.g. the
  // duplicate-resolution drawer in create-climb-form).
  if (onSetActive) {
    return (
      <div className={styles.cardWrapper}>
        <button type="button" onClick={handleCardClick} className={`${styles.card} ${styles.cardButton}`}>
          {cardInner}
        </button>
        {ellipsis}
      </div>
    );
  }

  if (climbViewPath) {
    return (
      <div className={styles.cardWrapper}>
        <LocaleLink href={climbViewPath} className={styles.card}>
          {cardInner}
        </LocaleLink>
        {ellipsis}
      </div>
    );
  }

  return <div className={`${styles.card} ${styles.cardDisabled}`}>{cardInner}</div>;
}

type SimilarClimbActionsDrawerProps = {
  climb: SimilarClimb;
  boardType: BoardName;
  /** The viewer's current wall config. When the similar climb fits on the
   *  same layout the viewer is on, the drawer uses this so action URLs
   *  (view, fork, open-in-app) point at the climb on the viewer's exact
   *  size + sets — what they'll actually try to climb on. */
  viewerBoardDetails: BoardDetails | undefined;
  onClose: () => void;
};

function SimilarClimbActionsDrawer({ climb, boardType, viewerBoardDetails, onClose }: SimilarClimbActionsDrawerProps) {
  const { t } = useTranslation('climbs');
  const { showMessage } = useSnackbar();
  const boardDetails = useMemo<BoardDetails | null>(() => {
    // Use the viewer's wall config when the similar climb fits on it —
    // action URLs (view / fork / open-in-app) then point at the climb
    // on the user's exact size + sets, matching what they'll actually
    // try to climb. For incompatible climbs we keep the default config:
    // sending the user to a URL on their size that physically can't
    // render the holds would be confusing, so we route them to the
    // biggest reasonable config for the climb's layout.
    const compatible =
      viewerBoardDetails != null &&
      viewerBoardDetails.layout_id === climb.layoutId &&
      climb.compatibleSizeIds.includes(viewerBoardDetails.size_id);
    if (compatible) {
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
  }, [boardType, climb.layoutId, climb.compatibleSizeIds, viewerBoardDetails]);

  // No boardDetails means we can't compute URLs for the actions, so dismiss
  // the drawer and tell the user — otherwise tapping the ellipsis just makes
  // the sheet flash open and disappear with no explanation. Effect rather
  // than calling onClose() inline — calling a parent state setter during
  // render triggers React's render-time update warning and risks an
  // infinite loop.
  useEffect(() => {
    if (!boardDetails) {
      showMessage(t('similarClimbs.actionsUnavailable'), 'info');
      onClose();
    }
  }, [boardDetails, onClose, showMessage, t]);

  if (!boardDetails) return null;

  return (
    <ClimbActionsDrawer open onClose={onClose} climb={buildClimbStub(climb, boardType)} boardDetails={boardDetails} />
  );
}

/**
 * Compose the "setter · ★N · Y sends" byline shown under the climb name.
 * Skips any segment that's missing data — most user-created climbs have no
 * quality rating or ascent count yet, so we don't want to show stale zeros.
 */
function formatByline(climb: SimilarClimb): string {
  const parts: string[] = [];
  if (climb.setterUsername) parts.push(climb.setterUsername);
  if (typeof climb.qualityAverage === 'number' && climb.qualityAverage > 0) {
    parts.push(`★${climb.qualityAverage.toFixed(1)}`);
  }
  if (typeof climb.ascensionistCount === 'number' && climb.ascensionistCount > 0) {
    parts.push(formatSends(climb.ascensionistCount));
  }
  return parts.join(' · ');
}

/**
 * Build a `Climb` from a `SimilarClimb` for downstream consumers
 * (`setCurrentClimb`, `ClimbActions`) that expect the full type. Stats fields
 * the similar-climbs query doesn't include get safe defaults; the queue and
 * drawer re-fetch the canonical row from board search by uuid on activation.
 *
 * `stars`, `difficulty_error`, `benchmark_difficulty`, and the empty
 * `quality_average` / `difficulty` strings are intentional placeholder
 * values for the window between activation and the search refetch
 * resolving — typically a single roundtrip (~100ms). UI consumers that
 * render these fields (the queue card, the actions sheet) already render
 * empty-state copy when these are blank, so the brief swap is not visible
 * as a flash of misleading data; we accept the latency rather than
 * over-fetching every similar-climbs hit just to pre-populate fields the
 * user may never see.
 */
function buildClimbStub(similar: SimilarClimb, boardType: BoardName): Climb {
  return {
    uuid: similar.uuid,
    layoutId: similar.layoutId,
    boardType,
    name: similar.name ?? '',
    setter_username: similar.setterUsername ?? '',
    frames: similar.frames ?? '',
    angle: similar.angle ?? 0,
    description: '',
    ascensionist_count: similar.ascensionistCount ?? 0,
    difficulty: similar.difficultyName ?? '',
    quality_average: similar.qualityAverage == null ? '' : similar.qualityAverage.toFixed(2),
    stars: 0,
    difficulty_error: '',
    benchmark_difficulty: null,
  };
}
