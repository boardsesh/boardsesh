import 'server-only';

import { revalidateTag } from 'next/cache';
import type { BoardName } from '@/app/lib/types';
import { getBoardClimbSearchTag } from '@/app/lib/climb-search-cache';

type RevalidateClimbSearchTagsOptions = {
  boardName: BoardName;
};

// Async so the route can keep awaiting it. It used to emit a server-side
// analytics event alongside the invalidation, hence the header/layout/source
// arguments that are gone with it.
export async function revalidateClimbSearchTags({ boardName }: RevalidateClimbSearchTagsOptions): Promise<void> {
  // Cache entries are tagged at board level (not layout level), so board-level
  // invalidation covers all layouts including the one a climb was just saved to.
  revalidateTag(getBoardClimbSearchTag(boardName), { expire: 0 });
}
