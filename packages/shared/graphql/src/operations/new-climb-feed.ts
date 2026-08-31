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
      similarity
      sharedHoldCount
      candidateHoldCount
      targetHoldCount
    }
  }
`;

export const SAVE_CLIMB_MUTATION = gql`
  mutation SaveClimb($input: SaveClimbInput!) {
    saveClimb(input: $input) {
      uuid
      controllerRouteUuid
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
