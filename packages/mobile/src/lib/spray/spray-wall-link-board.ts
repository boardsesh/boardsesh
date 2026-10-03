import type { QueryClient } from '@tanstack/react-query';
import { GET_SPRAY_WALL_FOR_LINK } from '@boardsesh/graphql/operations/spray-walls';
import type { SprayWall } from '@boardsesh/graphql/generated/graphql';
import type { UserBoard } from '@boardsesh/shared-schema';
import { getHttpClient } from '../graphql/client';
import { captureAuthCredentialGeneration, isAuthCredentialGenerationCurrent } from '../auth-store';
import { sprayWallByLayoutQueryKey } from './spray-wall-loader';
import { refreshSprayWall } from './spray-wall-registry';

/**
 * Redeem a capability before adopting its board. Always ask the server again:
 * a cached wall may have become private or hidden since the last shared link.
 * Keep the answer scoped to this URL; a UUID for another wall grants no access
 * to the requested slug, and must never populate the enumerable slug cache.
 */
export async function fetchSprayWallBoardFromLink(
  queryClient: QueryClient,
  wallUuid: string,
  slug: string,
): Promise<UserBoard | null> {
  const credentialGeneration = captureAuthCredentialGeneration();
  const response = await getHttpClient().request<{ sprayWall: (SprayWall & { board: UserBoard }) | null }>(
    GET_SPRAY_WALL_FOR_LINK,
    { uuid: wallUuid },
  );
  if (!isAuthCredentialGenerationCurrent(credentialGeneration)) return null;
  const wall = response.sprayWall;
  if (
    !wall ||
    wall.uuid.toLowerCase() !== wallUuid.toLowerCase() ||
    wall.board.uuid.toLowerCase() !== wallUuid.toLowerCase() ||
    wall.board.slug !== slug ||
    wall.board.boardType !== 'spray' ||
    wall.board.layoutId !== wall.layoutId
  ) {
    return null;
  }

  queryClient.setQueryData(sprayWallByLayoutQueryKey(wall.layoutId), { sprayWallByLayout: wall });
  refreshSprayWall(wall.layoutId);
  return wall.board;
}
