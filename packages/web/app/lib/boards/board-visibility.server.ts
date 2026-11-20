import 'server-only';
import { QUANTUM_BOARD_FLAG, type BoardVisibilityFlags } from '@boardsesh/board-config/visibility';
import { getPosthogDistinctId } from '@/app/lib/feature-flags/server-distinct-id';
import { getServerFeatureFlag } from '@/app/lib/feature-flags/server-feature-flag';

export async function getBoardVisibilityFlags(distinctId?: string | null): Promise<BoardVisibilityFlags> {
  const viewerId = distinctId === undefined ? await getPosthogDistinctId() : distinctId;
  return {
    [QUANTUM_BOARD_FLAG]: await getServerFeatureFlag(QUANTUM_BOARD_FLAG, {
      distinctId: viewerId,
      allowAnonymous: true,
    }),
  };
}
