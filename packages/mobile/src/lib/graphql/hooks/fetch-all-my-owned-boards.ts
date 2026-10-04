import type { UserBoard } from '@boardsesh/shared-schema';
import { captureAuthCredentialGeneration, isAuthCredentialGenerationCurrent } from '../../auth-store';
import { getHttpClient } from '../client';
import { GET_PROFILE, type GetProfileQueryResponse } from '../operations';
import { fetchAllMyBoardsWithAuthFence } from './fetch-all-my-boards';

export type AuthenticatedOwnedBoards = {
  viewerId: string;
  boards: UserBoard[];
};

function requireProfileId(response: GetProfileQueryResponse): string {
  const profileId = response.profile?.id;
  if (typeof profileId !== 'string' || profileId.trim().length === 0) {
    throw new Error('Cannot verify the signed-in owner of this board list');
  }
  return profileId;
}

/**
 * Walk `myBoards` and retain only rows whose owner matches the authenticated
 * profile. `myBoards` also includes followed boards, so its name does not mean
 * every returned row belongs to the viewer. A credential-generation fence
 * covers every page, and the second profile read verifies the account ID after
 * the paginated list is collected.
 */
export async function fetchAllMyOwnedBoards(): Promise<AuthenticatedOwnedBoards> {
  const client = getHttpClient();
  const firstProfile = requireProfileId(await client.request<GetProfileQueryResponse>(GET_PROFILE));
  const credentialGeneration = captureAuthCredentialGeneration();
  const assertCredentialGeneration = (): void => {
    if (!isAuthCredentialGenerationCurrent(credentialGeneration)) {
      throw new Error('Authentication changed while loading owned boards');
    }
  };
  const boards = await fetchAllMyBoardsWithAuthFence(assertCredentialGeneration);
  assertCredentialGeneration();
  const finalProfile = requireProfileId(await client.request<GetProfileQueryResponse>(GET_PROFILE));
  assertCredentialGeneration();
  if (firstProfile !== finalProfile) {
    throw new Error('The signed-in account changed while loading owned boards');
  }

  if (boards.some((board) => typeof board.ownerId !== 'string' || board.ownerId.trim().length === 0)) {
    throw new Error('Cannot verify ownership for every board in the list');
  }

  return {
    viewerId: firstProfile,
    boards: boards.filter((board) => board.ownerId === firstProfile),
  };
}
