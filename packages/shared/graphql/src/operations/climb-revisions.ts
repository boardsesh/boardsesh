import { gql } from 'graphql-request';

export const GET_CLIMB_REVISIONS = gql`
  query GetClimbRevisions($boardType: String!, $climbUuid: String!) {
    climbRevisions(boardType: $boardType, climbUuid: $climbUuid) {
      revisionNumber
      isCurrent
      createdAt
      name
      description
      frames
      angle
      difficultyId
      changes
      editor {
        id
        displayName
        avatarUrl
      }
      editedBySetter
      sprayWallVersionNumber
    }
  }
`;

export type GetClimbRevisionsQueryVariables = { boardType: string; climbUuid: string };

/** What an edit changed. Mirrors `CLIMB_REVISION_CHANGES` in `@boardsesh/db`. */
export type ClimbRevisionChange = 'name' | 'description' | 'holds' | 'grade' | 'angle' | 'rules';

export type ClimbRevisionRow = {
  revisionNumber: number;
  /** True for the newest revision, which matches the live climb. */
  isCurrent: boolean;
  /** When the edit was made. For revision 1, when the climb was published. */
  createdAt: string;
  name: string | null;
  description: string | null;
  frames: string | null;
  angle: number | null;
  /** The setter grade at this revision. Spray walls only. */
  difficultyId: number | null;
  /** Typed loosely on purpose: an older client must not choke on a change kind added later. */
  changes: Array<ClimbRevisionChange | (string & {})>;
  editor: { id: string; displayName: string | null; avatarUrl: string | null } | null;
  editedBySetter: boolean;
  /** Spray walls only: the wall version to render this revision on. */
  sprayWallVersionNumber: number | null;
};

export type GetClimbRevisionsQueryResponse = { climbRevisions: ClimbRevisionRow[] };
