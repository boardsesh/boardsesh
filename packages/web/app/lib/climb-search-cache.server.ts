import 'server-only';

import { revalidateTag } from 'next/cache';
import { track } from '@/app/lib/analytics.server';
import type { BoardName } from '@/app/lib/types';
import { getBoardClimbSearchTag } from '@/app/lib/climb-search-cache';

export type ClimbSearchInvalidationSource = 'internal-route';

type RevalidateClimbSearchTagsOptions = {
  boardName: BoardName;
  layoutId?: number;
  requestHeaders?: Headers;
  source: ClimbSearchInvalidationSource;
};

export async function revalidateClimbSearchTags({
  boardName,
  layoutId,
  requestHeaders,
  source,
}: RevalidateClimbSearchTagsOptions): Promise<void> {
  // Cache entries are tagged at board level (not layout level), so board-level
  // invalidation covers all layouts including the one a climb was just saved to.
  revalidateTag(getBoardClimbSearchTag(boardName), { expire: 0 });

  if (!requestHeaders) {
    return;
  }

  await track(
    'Climb Search Cache Invalidated',
    {
      boardName,
      layoutId: layoutId ?? null,
      source,
    },
    { headers: requestHeaders },
  );
}
