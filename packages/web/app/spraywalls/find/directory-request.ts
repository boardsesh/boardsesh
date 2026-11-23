import { GraphQLClient } from 'graphql-request';
import {
  SEARCH_SPRAY_WALLS_DIRECTORY,
  type SearchSprayWallsDirectoryQueryResponse,
  type SearchSprayWallsDirectoryQueryVariables,
} from '@boardsesh/graphql/operations';
import type { SearchBoardsInput } from '@boardsesh/shared-schema';
import { getGraphQLHttpUrl } from '@/app/lib/backend-url';
import { webClientIdentityHeaders } from '@/app/lib/client-identity';

/** Public discovery always reads as a stranger, including in a signed-in browser. */
export async function requestSprayDirectory(input: SearchBoardsInput, signal?: AbortSignal) {
  const deadline = AbortSignal.timeout(4000);
  const client = new GraphQLClient(getGraphQLHttpUrl(), {
    headers: webClientIdentityHeaders(),
    credentials: 'omit',
    cache: 'no-store',
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
  const response = await client.request<
    SearchSprayWallsDirectoryQueryResponse,
    SearchSprayWallsDirectoryQueryVariables
  >(SEARCH_SPRAY_WALLS_DIRECTORY, { input: { ...input, boardType: 'spray' } });
  return response.searchBoards;
}
