import { gql } from 'graphql-request';
import type {
  CheckMoonBoardClimbDuplicatesInput,
  NewClimbFeedInput,
  NewClimbFeedResult,
  NewClimbSubscription,
  NewClimbSubscriptionInput,
  NewClimbCreatedEvent,
  MoonBoardClimbDuplicateMatch,
  SaveClimbInput,
  SaveClimbResult,
  SaveMoonBoardClimbInput,
  SimilarClimb,
  SimilarClimbsInput,
  UpdateClimbInput,
  UpdateClimbResult,
} from '@boardsesh/shared-schema';

export const GET_NEW_CLIMB_FEED = gql`
  query GetNewClimbFeed($input: NewClimbFeedInput!) {
    newClimbFeed(input: $input) {
      items {
        uuid
        name
        boardType
        layoutId
        setterDisplayName
        setterAvatarUrl
        angle
        frames
        difficultyName
        isNoMatch
        createdAt
      }
      totalCount
      hasMore
    }
  }
`;

export const GET_MY_NEW_CLIMB_SUBSCRIPTIONS = gql`
  query GetMyNewClimbSubscriptions {
    myNewClimbSubscriptions {
      id
      boardType
      layoutId
      createdAt
    }
  }
`;

export const SUBSCRIBE_NEW_CLIMBS = gql`
  mutation SubscribeNewClimbs($input: NewClimbSubscriptionInput!) {
    subscribeNewClimbs(input: $input)
  }
`;

export const UNSUBSCRIBE_NEW_CLIMBS = gql`
  mutation UnsubscribeNewClimbs($input: NewClimbSubscriptionInput!) {
    unsubscribeNewClimbs(input: $input)
  }
`;

export const NEW_CLIMB_CREATED_SUBSCRIPTION = gql`
  subscription OnNewClimbCreated($boardType: String!, $layoutId: Int!) {
    newClimbCreated(boardType: $boardType, layoutId: $layoutId) {
      climb {
        uuid
        name
        boardType
        layoutId
        setterDisplayName
        setterAvatarUrl
        angle
        frames
        difficultyName
        isNoMatch
        createdAt
      }
    }
  }
`;

export const CHECK_MOONBOARD_CLIMB_DUPLICATES_QUERY = gql`
  query CheckMoonBoardClimbDuplicates($input: CheckMoonBoardClimbDuplicatesInput!) {
    checkMoonBoardClimbDuplicates(input: $input) {
      clientKey
      exists
      existingClimbUuid
      existingClimbName
    }
  }
`;

export const SIMILAR_CLIMBS_QUERY = gql`
  query SimilarClimbs($input: SimilarClimbsInput!) {
    similarClimbs(input: $input) {
      uuid
      name
      setterUsername
      angle
      layoutId
      frames
      difficultyName
      qualityAverage
      ascensionistCount
      compatibleSizeIds
      characteristics
      similarity
      sharedHoldCount
      candidateHoldCount
      targetHoldCount
    }
  }
`;

/**
 * Create a climb on any board but MoonBoard.
 *
 * **On `boardType: 'spray'` the input needs two extra fields.** `userGrade` is
 * required to publish — a spray wall has no crowd grade to converge on, so the
 * setter's grade is the only one the climb will ever have. And `sprayWallUuid`
 * carries the wall's uuid, which is the capability an unlisted wall's share link
 * hands out: without it a caller who is neither the owner nor a member of the
 * wall's gym is refused, because the `layoutId` in the input comes out of a
 * sequence and authorizes nothing on its own. Send it unconditionally — it is
 * ignored when the caller is already a principal. See `docs/spray-walls.md`.
 */
export const SAVE_CLIMB_MUTATION = gql`
  mutation SaveClimb($input: SaveClimbInput!) {
    saveClimb(input: $input) {
      uuid
      synced
      createdAt
      publishedAt
    }
  }
`;

export const SAVE_MOONBOARD_CLIMB_MUTATION = gql`
  mutation SaveMoonBoardClimb($input: SaveMoonBoardClimbInput!) {
    saveMoonBoardClimb(input: $input) {
      uuid
      synced
      createdAt
      publishedAt
    }
  }
`;

/**
 * Edit a climb in place.
 *
 * On `boardType: 'spray'` this needs `sprayWallUuid` for the same reason
 * `SAVE_CLIMB_MUTATION` does: the wall is resolved from the stored climb's
 * `layoutId`, which is not a secret, so a link-holder has to present the
 * capability again on every edit.
 */
export const UPDATE_CLIMB_MUTATION = gql`
  mutation UpdateClimb($input: UpdateClimbInput!) {
    updateClimb(input: $input) {
      uuid
      createdAt
      publishedAt
      isDraft
    }
  }
`;

export const DELETE_DRAFT_CLIMB_MUTATION = gql`
  mutation DeleteDraftClimb($uuid: ID!, $boardType: String!) {
    deleteDraftClimb(uuid: $uuid, boardType: $boardType)
  }
`;

export type GetNewClimbFeedVariables = {
  input: NewClimbFeedInput;
};

export type GetNewClimbFeedResponse = {
  newClimbFeed: NewClimbFeedResult;
};

export type GetMyNewClimbSubscriptionsResponse = {
  myNewClimbSubscriptions: NewClimbSubscription[];
};

export type SubscribeNewClimbsVariables = {
  input: NewClimbSubscriptionInput;
};

export type SubscribeNewClimbsResponse = {
  subscribeNewClimbs: boolean;
};

export type UnsubscribeNewClimbsVariables = {
  input: NewClimbSubscriptionInput;
};

export type UnsubscribeNewClimbsResponse = {
  unsubscribeNewClimbs: boolean;
};

export type NewClimbCreatedSubscriptionPayload = {
  newClimbCreated: NewClimbCreatedEvent;
};

export type SaveClimbMutationVariables = {
  input: SaveClimbInput;
};

export type SaveClimbMutationResponse = {
  saveClimb: SaveClimbResult;
};

export type CheckMoonBoardClimbDuplicatesVariables = {
  input: CheckMoonBoardClimbDuplicatesInput;
};

export type CheckMoonBoardClimbDuplicatesResponse = {
  checkMoonBoardClimbDuplicates: MoonBoardClimbDuplicateMatch[];
};

export type SaveMoonBoardClimbMutationVariables = {
  input: SaveMoonBoardClimbInput;
};

export type SaveMoonBoardClimbMutationResponse = {
  saveMoonBoardClimb: SaveClimbResult;
};

export type UpdateClimbMutationVariables = {
  input: UpdateClimbInput;
};

export type UpdateClimbMutationResponse = {
  updateClimb: UpdateClimbResult;
};

export type DeleteDraftClimbMutationVariables = {
  uuid: string;
  boardType: string;
};

export type DeleteDraftClimbMutationResponse = {
  deleteDraftClimb: boolean;
};

export type SimilarClimbsVariables = {
  input: SimilarClimbsInput;
};

export type SimilarClimbsResponse = {
  similarClimbs: SimilarClimb[];
};
