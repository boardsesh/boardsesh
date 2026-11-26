import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { visuallyHidden } from '@mui/utils';
import { buildBoardArtLayers, toDarkArtUrl } from '@/app/components/board-renderer/util';
import { getServerTranslation } from '@/app/lib/i18n/server';
import GradeTile from '@/app/components/climb-front-door/grade-tile';
import LocaleLink from '@/app/components/i18n/locale-link';
import { formatSends, type TranslateSends } from '@/app/lib/format-climb-stats';
import { formatFontGrade, formatVGrade } from '@/app/lib/grade-colors';
import { climbGradeForSearch } from '@/app/lib/seo/climb-display';
import { getBoardImageDetailsForBoard } from '@/app/lib/board-image-details';
import { resolveRenderBoard } from '@boardsesh/board-config/resolve-render-board';
import { getDefaultBoardConfig, getDefaultClimbViewPath } from '@/app/lib/default-board-configs';

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
  boardSlug?: string;
  viewerBoardDetails?: BoardImageDetails;
  climbs?: ClimbPreview[];
  emptyMessage: string;
  pendingMessage?: string;
};

/** Public discovery is read-only: no query client or hydration-time refetch. */
export default async function SimilarClimbsList({
  climbs,
  emptyMessage,
  pendingMessage,
  ...board
}: SimilarClimbsListProps) {
  if (!climbs || climbs.length === 0) {
    return (
      <Typography variant="body2" component="p" color="text.secondary" sx={{ py: 2 }}>
        {climbs ? emptyMessage : pendingMessage}
      </Typography>
    );
  }
  return ClimbPreviewRows({ climbs, ...board });
}

export async function ClimbPreviewRows({
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
  const { t } = await getServerTranslation('climbs');
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
            translate={t}
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
  translate: Awaited<ReturnType<typeof getServerTranslation>>['t'];
};

function SimilarClimbRow({
  climb,
  boardType,
  boardSlug,
  viewerBoardDetails,
  compatible,
  translate: t,
}: SimilarClimbRowProps) {
  const angle = climb.angle ?? 0;
  const difficulty = climb.difficultyName ?? null;

  // Compatible climb: render at the viewer's exact wall config so the
  // thumbnail matches what they'll see on their board. Incompatible:
  // fall back to the layout's default (biggest reasonable) config so the
  // climb's full footprint is visible even though the user can't load it.
  const boardDetails: BoardImageDetails | null = (() => {
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
  })();

  const climbViewPath = (() => {
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
  })();

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
        {boardDetails ? <StaticBoardThumbnail boardDetails={boardDetails} frames={climb.frames} /> : null}
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

  if (climbViewPath) {
    return (
      <Box component="li" className={styles.item}>
        <LocaleLink href={climbViewPath} prefetch={false} className={styles.row}>
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

function StaticBoardThumbnail({
  boardDetails,
  frames,
}: {
  boardDetails: BoardImageDetails;
  frames: string | null | undefined;
}) {
  const { backgroundUrls, overlayUrl } = buildBoardArtLayers(boardDetails, frames, true);
  return (
    <Box className={styles.boardArt}>
      {backgroundUrls.map((backgroundUrl) => (
        <Box
          component="img"
          key={backgroundUrl}
          src={toDarkArtUrl(backgroundUrl)}
          alt=""
          width={boardDetails.boardWidth}
          height={boardDetails.boardHeight}
          loading="lazy"
          decoding="async"
        />
      ))}
      {overlayUrl ? (
        <Box
          component="img"
          src={overlayUrl}
          alt=""
          width={boardDetails.boardWidth}
          height={boardDetails.boardHeight}
          loading="lazy"
          decoding="async"
        />
      ) : null}
    </Box>
  );
}
