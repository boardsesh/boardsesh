import 'server-only';
import { getBoardLaunchFlags, type BoardVisibilityFlags } from '@boardsesh/board-config/visibility';
import { getPosthogDistinctId } from '@/app/lib/feature-flags/server-distinct-id';
import { getServerFeatureFlag } from '@/app/lib/feature-flags/server-feature-flag';

/** Every board launch flag in the capability table, resolved for the admitted viewer (anonymous visitors included). */
export async function getBoardVisibilityFlags(distinctId?: string | null): Promise<BoardVisibilityFlags> {
  const viewerId = distinctId === undefined ? await getPosthogDistinctId() : distinctId;
  const launchFlags = getBoardLaunchFlags();
  const launchFlagValues = await Promise.all(
    launchFlags.map((launchFlag) => getServerFeatureFlag(launchFlag, { distinctId: viewerId, allowAnonymous: true })),
  );
  const visibilityFlags: Record<string, boolean> = {};
  launchFlags.forEach((launchFlag, flagIndex) => {
    visibilityFlags[launchFlag] = launchFlagValues[flagIndex];
  });
  return visibilityFlags;
}
