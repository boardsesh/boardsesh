'use client';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Avatar from '@mui/material/Avatar';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import PersonOutlined from '@mui/icons-material/PersonOutlined';
import LocationOnOutlined from '@mui/icons-material/LocationOnOutlined';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import type { NewClimbFeedItem } from '@boardsesh/shared-schema';
import AscentThumbnail from '@/app/components/activity-feed/ascent-thumbnail';
import ClimbIcons from '@/app/components/climb-card/climb-icons';
import { getDefaultBoardConfig, getDefaultClimbViewPath } from '@/app/lib/default-board-configs';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import { constructClimbViewUrlWithSlugs, tryConstructSlugViewUrl } from '@/app/lib/url-utils';
import type { BoardName } from '@/app/lib/types';
import LocaleLink from '@/app/components/i18n/locale-link';

dayjs.extend(relativeTime);

type NewClimbFeedItemProps = {
  item: NewClimbFeedItem;
};

export default function NewClimbFeedItem({ item }: NewClimbFeedItemProps) {
  const timeAgo = dayjs(item.createdAt).fromNow();
  const climbViewPath = (() => {
    const boardName = item.boardType as BoardName;
    const angle = item.angle ?? 0;

    // Try to build friendly slug path using board details
    const defaultConfig = getDefaultBoardConfig(boardName, item.layoutId);
    if (defaultConfig) {
      // Id-aware first: this matches every other view-URL call site. The
      // layout default isn't a shadowed size today, but building from names
      // is the shape that silently points at the wrong board the moment it
      // becomes one (see `resolveSizeSlug`).
      const idAwarePath = tryConstructSlugViewUrl(
        boardName,
        item.layoutId,
        defaultConfig.sizeId,
        defaultConfig.setIds,
        angle,
        item.uuid,
        item.name || undefined,
      );
      if (idAwarePath) return idAwarePath;

      const details = getBoardDetailsForBoard({
        board_name: boardName,
        layout_id: item.layoutId,
        size_id: defaultConfig.sizeId,
        set_ids: defaultConfig.setIds,
      });

      if (details?.layout_name && details.size_name && details.set_names) {
        return constructClimbViewUrlWithSlugs(
          boardName,
          details.layout_name,
          details.size_name,
          details.size_description,
          details.set_names,
          angle,
          item.uuid,
          item.name || undefined,
        );
      }
    }

    // Fallback to default path
    return getDefaultClimbViewPath(boardName, item.layoutId, angle, item.uuid, item.name || undefined);
  })();

  return (
    <Card variant="outlined" sx={{ mb: 1.5 }}>
      <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <Avatar src={item.setterAvatarUrl ?? undefined} sx={{ width: 32, height: 32 }}>
            {!item.setterAvatarUrl && <PersonOutlined fontSize="small" />}
          </Avatar>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="body2" fontWeight={600} noWrap>
              {item.setterDisplayName || 'Setter'}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {timeAgo}
            </Typography>
          </Box>
          {item.boardType && (
            <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'capitalize' }}>
              {item.boardType}
            </Typography>
          )}
        </Box>

        <LocaleLink href={climbViewPath ?? '#'} style={{ textDecoration: 'none', color: 'inherit' }}>
          <Box sx={{ display: 'flex', gap: 1.25 }}>
            {item.frames && (
              <AscentThumbnail
                boardType={item.boardType}
                layoutId={item.layoutId}
                angle={item.angle ?? 0}
                climbUuid={item.uuid}
                climbName={item.name || ''}
                frames={item.frames}
                isMirror={false}
              />
            )}

            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, flex: 1, minWidth: 0 }}>
              <Typography variant="subtitle1" fontWeight={700} noWrap>
                {item.name || 'Untitled climb'}
                <ClimbIcons isNoMatch={!!item.isNoMatch} />
              </Typography>
              <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', alignItems: 'center' }}>
                {item.difficultyName && <Chip label={item.difficultyName} size="small" color="primary" />}
                {item.angle != null && (
                  <Chip icon={<LocationOnOutlined />} label={`${item.angle}\u00B0`} size="small" />
                )}
              </Box>
            </Box>
          </Box>
        </LocaleLink>
      </CardContent>
    </Card>
  );
}
