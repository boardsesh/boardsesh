import { gql } from 'graphql-request';
import type { SyncClimbDocuments } from '@boardsesh/shared-schema';

export const SAVED_CLIMB_DOCUMENTS = gql`
  query SavedClimbDocuments($boardType: String!, $layoutId: Int!, $climbUuid: ID!, $sprayWallUuid: ID) {
    syncClimbDocuments(
      boardType: $boardType
      layoutId: $layoutId
      climbUuid: $climbUuid
      sprayWallUuid: $sprayWallUuid
    ) {
      viewerId
      climb
      stats
    }
  }
`;
export type SavedClimbDocumentsResponse = { syncClimbDocuments: SyncClimbDocuments | null };
