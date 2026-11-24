'use client';

import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import type { BoardDiscoveryBoard, BoardDiscoveryClimb } from '@boardsesh/shared-schema';
import { SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import LocaleLink from '@/app/components/i18n/locale-link';
import { getBoardImageDetailsForBoard } from '@/app/lib/board-image-details';
import { boardArtColorScheme, buildBoardRenderUrl } from '@/app/components/board-renderer/util';
import { constructBoardSlugViewUrl } from '@/app/lib/url-utils';

/** Optional during backend rollout; currentClimb always remains presence-only. */
export type GymPopularPreviewBoard = BoardDiscoveryBoard & { popularClimb?: BoardDiscoveryClimb | null };

export default function GymPopularClimbPreview({
  board,
  heading,
  description,
}: {
  board: GymPopularPreviewBoard;
  heading: string;
  description: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const preview = useMemo(() => {
    const climb = board.popularClimb;
    const boardName = SUPPORTED_BOARDS.find((name) => name === board.boardType);
    if (!climb?.frames || !boardName || boardName === 'spray') return null;
    try {
      const details = getBoardImageDetailsForBoard({
        board_name: boardName,
        layout_id: board.layoutId,
        size_id: board.sizeId,
        set_ids: board.setIds.split(',').map(Number),
      });
      return {
        url: buildBoardRenderUrl(details, climb.frames, {
          includeBackground: true,
          colorScheme: boardArtColorScheme(boardName),
        }),
        href: constructBoardSlugViewUrl(
          encodeURIComponent(board.slug),
          climb.angle,
          climb.uuid,
          climb.name ?? undefined,
        ),
      };
    } catch {
      return null;
    }
  }, [board]);
  if (!preview || preview.url === failedUrl) return null;
  return (
    <Box component="section" sx={{ my: 3 }}>
      <Typography component="h2" variant="h6">
        {heading}
      </Typography>
      <Typography variant="subtitle2">{board.name}</Typography>
      <Typography variant="body2" sx={{ color: 'var(--neutral-500)', mb: 2 }}>
        {description}
      </Typography>
      <MuiLink component={LocaleLink} href={preview.href} sx={{ display: 'block', width: '100%', maxWidth: 320 }}>
        <Box
          component="img"
          src={preview.url}
          alt={board.popularClimb?.name || heading}
          loading="lazy"
          onError={() => setFailedUrl(preview.url)}
          sx={{ display: 'block', width: '100%', height: 320, objectFit: 'contain' }}
        />
        {board.popularClimb?.name && <Typography component="span">{board.popularClimb.name}</Typography>}
      </MuiLink>
    </Box>
  );
}
