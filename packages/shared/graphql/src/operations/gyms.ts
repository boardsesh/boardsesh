import { gql } from 'graphql-request';
import type {
  Gym,
  GymBoardSummary,
  GymConnection,
  MyGymClaim,
  GymMemberConnection,
  CreateGymInput,
  UpdateGymInput,
  AddGymMemberInput,
  RemoveGymMemberInput,
  FollowGymInput,
  MyGymsInput,
  SearchGymsInput,
  GymMembersInput,
  LinkBoardToGymInput,
  GrantGymWriteAccessInput,
  RevokeGymWriteAccessInput,
  RequestGymClaimInput,
  RequestGymClaimResult,
  ReviewGymClaimInput,
  PendingGymClaimsInput,
  GymClaimConnection,
  FindSimilarGymsInput,
  SimilarGym,
  StrayBoard,
  AttachBoardToGymInput,
  UserBoard,
  GymStats,
  GymStatsInput,
  DuplicateGymClustersInput,
  DuplicateGymClusterConnection,
  OrphanGymsInput,
  OrphanGymConnection,
  MergeGymsInput,
  MergeGymsResult,
  DismissGymClusterInput,
  ReportGymDuplicateInput,
  ReportGymDuplicateResult,
} from '@boardsesh/shared-schema';

// ============================================
// Gym Queries
// ============================================

/**
 * Shared by GET_GYM, GET_GYM_BY_SLUG, GET_MY_GYMS and SEARCH_GYMS, all typed
 * `Gym`/`GymConnection` — so every field the `Gym` type declares as REQUIRED has
 * to be selected here, or consumers read `undefined` while TypeScript promises a
 * value. `isClaimed` is in for exactly that reason (and it's one boolean off
 * `gym.ownerId`, already loaded, no extra query). `boardSummaries` stays out and
 * is optional on the type instead: it's a list, only the directory renders it,
 * and mobile's gym picker rides this fragment at limit 50.
 */
const GYM_FIELDS = `
  uuid
  slug
  ownerId
  ownerDisplayName
  ownerAvatarUrl
  name
  description
  hours
  hoursUpdatedAt
  address
  website
  contactEmail
  contactPhone
  latitude
  longitude
  isPublic
  imageUrl
  logoUrl
  brandPrimaryColor
  brandAccentColor
  brandBackgroundColor
  createdAt
  boardCount
  boardTypes
  memberCount
  followerCount
  commentCount
  isFollowedByMe
  isMember
  myRole
  canEdit
  canGrantAccess
  canClaim
  isClaimed
  canClaimByDomain
`;

export const GET_GYM = gql`
  query GetGym($gymUuid: ID!) {
    gym(gymUuid: $gymUuid) {
      ${GYM_FIELDS}
    }
  }
`;

export const GET_GYM_BY_SLUG = gql`
  query GetGymBySlug($slug: String!) {
    gymBySlug(slug: $slug) {
      ${GYM_FIELDS}
    }
  }
`;

/**
 * The viewer's own in-flight claim on a gym. A SEPARATE document from
 * GET_GYM_BY_SLUG on purpose — this is a deploy-ordering firewall, not a style
 * choice.
 *
 * A field is only answerable once the backend declaring it is live, and an
 * unknown field fails validation for the WHOLE document. Folded into
 * GET_GYM_BY_SLUG, a web-deploys-first ordering would therefore take the gym
 * page and the manage console down together — both treat a failed fetch as
 * "gym not found" and render a 404 — until the backend caught up. Split out,
 * the same failure costs exactly one notice on one page.
 *
 * The mirror-image constraint is why it is not in GYM_FIELDS either: GET_GYM
 * ships inside the mobile app, whose production OTA auto-publishes on every
 * push to main and can reach devices BEFORE the backend deploy.
 */
export const GET_GYM_PENDING_CLAIM = gql`
  query GetGymPendingClaim($slug: String!) {
    gymBySlug(slug: $slug) {
      uuid
      myPendingClaim {
        id
        method
        createdAt
      }
    }
  }
`;

export const GET_MY_GYMS = gql`
  query GetMyGyms($input: MyGymsInput) {
    myGyms(input: $input) {
      gyms {
        ${GYM_FIELDS}
      }
      totalCount
      hasMore
    }
  }
`;

export const SEARCH_GYMS = gql`
  query SearchGyms($input: SearchGymsInput!) {
    searchGyms(input: $input) {
      gyms {
        ${GYM_FIELDS}
      }
      totalCount
      hasMore
    }
  }
`;

/**
 * The public `/gyms` directory list. A separate document from SEARCH_GYMS on
 * purpose: it selects only what a directory card renders, so the card's cost
 * doesn't ride along on GET_GYM / GET_MY_GYMS / SEARCH_GYMS. `boardSummaries` in
 * particular stays out of the shared GYM_FIELDS — it's a list, and mobile's
 * useNearbyGyms rides that fragment at limit 50 for a picker that never draws
 * board chips.
 *
 * It selects nothing the card doesn't draw, and that is a rule rather than an
 * accident: `boardCount` is redundant next to `boardSummaries`, and `hasMore`
 * is unused because paging is driven by `totalCount` and the page size. Add a
 * field here only when something renders it.
 */
export const SEARCH_GYMS_DIRECTORY = gql`
  query SearchGymsDirectory($input: SearchGymsInput!) {
    searchGyms(input: $input) {
      gyms {
        uuid
        slug
        name
        address
        latitude
        longitude
        isClaimed
        boardSummaries {
          boardType
          angle
        }
      }
      totalCount
    }
  }
`;

export const FIND_SIMILAR_GYMS = gql`
  query FindSimilarGyms($input: FindSimilarGymsInput!) {
    findSimilarGyms(input: $input) {
      uuid
      slug
      name
      address
      website
      distanceMeters
      ownerType
      isClaimable
      canClaimByDomain
      providerOrigins
    }
  }
`;

export const GET_GYM_MEMBERS = gql`
  query GetGymMembers($input: GymMembersInput!) {
    gymMembers(input: $input) {
      members {
        userId
        displayName
        avatarUrl
        role
        createdAt
      }
      totalCount
      hasMore
    }
  }
`;

// Board fields the manage-gym board pickers and the leaderboard embed read from
// gymBoards. `boardId` is the numeric board-presence channel id (null unless the
// board is public or the viewer can edit it) — it feeds boardNowPlaying(boardId).
const GYM_BOARD_FIELDS = `
  uuid
  slug
  ownerId
  name
  boardType
  layoutId
  sizeId
  setIds
  angle
  isAngleAdjustable
  isPublic
  isUnlisted
  locationName
  gymId
  gymUuid
  boardId
  canEdit
`;

export const GET_GYM_BOARDS = gql`
  query GetGymBoards($gymUuid: ID!) {
    gymBoards(gymUuid: $gymUuid) {
      ${GYM_BOARD_FIELDS}
    }
  }
`;

// Boards that probably belong to the gym but aren't linked yet — merged-twin
// leftovers and nearby unlinked/SYSTEM boards. Powers the "Boards that might be
// yours" section on the manage-gym Boards tab. Requires gym edit access.
export const STRAY_BOARDS_FOR_GYM = gql`
  query StrayBoardsForGym($gymUuid: ID!) {
    strayBoardsForGym(gymUuid: $gymUuid) {
      uuid
      name
      currentGymUuid
      currentGymName
      distanceMeters
      reason
      isLastBoardAtCurrentGym
    }
  }
`;

// Owner Insights dashboard: current + prior window counts (for week-over-week
// deltas), the top-10 climbs, and busiest weekdays. Requires gym edit access.
export const GET_GYM_STATS = gql`
  query GetGymStats($input: GymStatsInput!) {
    gymStats(input: $input) {
      gymUuid
      periodDays
      current {
        uniqueClimbers
        ascentCount
      }
      previous {
        uniqueClimbers
        ascentCount
      }
      topClimbs {
        climbUuid
        boardType
        angle
        name
        gradeName
        ascentCount
      }
      busiestDays {
        dayOfWeek
        ascentCount
      }
    }
  }
`;

// ============================================
// Gym Mutations
// ============================================

export const CREATE_GYM = gql`
  mutation CreateGym($input: CreateGymInput!) {
    createGym(input: $input) {
      ${GYM_FIELDS}
    }
  }
`;

export const UPDATE_GYM = gql`
  mutation UpdateGym($input: UpdateGymInput!) {
    updateGym(input: $input) {
      ${GYM_FIELDS}
    }
  }
`;

export const DELETE_GYM = gql`
  mutation DeleteGym($gymUuid: ID!) {
    deleteGym(gymUuid: $gymUuid)
  }
`;

export const ADD_GYM_MEMBER = gql`
  mutation AddGymMember($input: AddGymMemberInput!) {
    addGymMember(input: $input)
  }
`;

export const REMOVE_GYM_MEMBER = gql`
  mutation RemoveGymMember($input: RemoveGymMemberInput!) {
    removeGymMember(input: $input)
  }
`;

export const FOLLOW_GYM = gql`
  mutation FollowGym($input: FollowGymInput!) {
    followGym(input: $input)
  }
`;

export const UNFOLLOW_GYM = gql`
  mutation UnfollowGym($input: FollowGymInput!) {
    unfollowGym(input: $input)
  }
`;

export const LINK_BOARD_TO_GYM = gql`
  mutation LinkBoardToGym($input: LinkBoardToGymInput!) {
    linkBoardToGym(input: $input)
  }
`;

export const ATTACH_BOARD_TO_GYM = gql`
  mutation AttachBoardToGym($input: AttachBoardToGymInput!) {
    attachBoardToGym(input: $input)
  }
`;

export const DETACH_BOARD_FROM_GYM = gql`
  mutation DetachBoardFromGym($input: DetachBoardFromGymInput!) {
    detachBoardFromGym(input: $input)
  }
`;

export const GRANT_GYM_WRITE_ACCESS = gql`
  mutation GrantGymWriteAccess($input: GrantGymWriteAccessInput!) {
    grantGymWriteAccess(input: $input)
  }
`;

export const REVOKE_GYM_WRITE_ACCESS = gql`
  mutation RevokeGymWriteAccess($input: RevokeGymWriteAccessInput!) {
    revokeGymWriteAccess(input: $input)
  }
`;

export const REQUEST_GYM_CLAIM = gql`
  mutation RequestGymClaim($input: RequestGymClaimInput!) {
    requestGymClaim(input: $input) {
      status
      email
    }
  }
`;

export const REVIEW_GYM_CLAIM = gql`
  mutation ReviewGymClaim($input: ReviewGymClaimInput!) {
    reviewGymClaim(input: $input)
  }
`;

// ============================================
// Gym Claim Admin Queue
// ============================================

const GYM_CLAIM_FIELDS = `
  id
  gymUuid
  gymName
  claimantUserId
  claimantDisplayName
  claimantAvatarUrl
  method
  status
  claimEmail
  message
  createdAt
`;

export const PENDING_GYM_CLAIMS = gql`
  query PendingGymClaims($input: PendingGymClaimsInput) {
    pendingGymClaims(input: $input) {
      claims {
        ${GYM_CLAIM_FIELDS}
      }
      totalCount
      hasMore
    }
  }
`;

// ============================================
// Gym Duplicate Review Admin Queue
// ============================================

const DUPLICATE_GYM_CLUSTER_FIELDS = `
  signature
  tier
  normalizedName
  suggestedCanonicalGymUuid
  maxDistanceMeters
  members {
    gymUuid
    name
    address
    ownerType
    claimStatus
    providerOrigins
    boardCount
    followerCount
    memberCount
    kioskCount
    claimCount
    createdAt
    latitude
    longitude
    distanceToCanonicalMeters
    isSuggestedCanonical
  }
`;

export const DUPLICATE_GYM_CLUSTERS = gql`
  query DuplicateGymClusters($input: DuplicateGymClustersInput) {
    duplicateGymClusters(input: $input) {
      clusters {
        ${DUPLICATE_GYM_CLUSTER_FIELDS}
      }
      totalCount
      hasMore
    }
  }
`;

export const ORPHAN_GYMS = gql`
  query OrphanGyms($input: OrphanGymsInput) {
    orphanGyms(input: $input) {
      gyms {
        gymUuid
        slug
        name
        address
        boardCount
        followerCount
        memberCount
        kioskCount
        createdAt
      }
      totalCount
      hasMore
    }
  }
`;

export const MERGE_GYMS = gql`
  mutation MergeGyms($input: MergeGymsInput!) {
    mergeGyms(input: $input) {
      canonicalGymUuid
      results {
        duplicateGymUuid
        counts {
          boards
          follows
          members
          claims
          kiosks
          comments
        }
        warnings {
          kioskUuid
          kioskName
          previousSlug
          newSlug
        }
      }
    }
  }
`;

export const DISMISS_GYM_CLUSTER = gql`
  mutation DismissGymCluster($input: DismissGymClusterInput!) {
    dismissGymCluster(input: $input)
  }
`;

export const REPORT_GYM_DUPLICATE = gql`
  mutation ReportGymDuplicate($input: ReportGymDuplicateInput!) {
    reportGymDuplicate(input: $input) {
      status
    }
  }
`;

// ============================================
// Query/Mutation Variable Types
// ============================================

export type GetGymQueryVariables = {
  gymUuid: string;
};

export type GetGymQueryResponse = {
  gym: Gym | null;
};

export type GetGymBySlugQueryVariables = {
  slug: string;
};

export type GetGymBySlugQueryResponse = {
  gymBySlug: Gym | null;
};

export type GetGymPendingClaimQueryVariables = {
  slug: string;
};

/**
 * Exactly what GET_GYM_PENDING_CLAIM selects. Deliberately not typed `Gym`: the
 * document fetches two fields, and a consumer that reads more than that from it
 * would be reading `undefined` behind a type that promises a value.
 */
export type GetGymPendingClaimQueryResponse = {
  gymBySlug: { uuid: string; myPendingClaim: MyGymClaim | null } | null;
};

export type GetMyGymsQueryVariables = {
  input?: MyGymsInput;
};

export type GetMyGymsQueryResponse = {
  myGyms: GymConnection;
};

export type SearchGymsQueryVariables = {
  input: SearchGymsInput;
};

export type SearchGymsQueryResponse = {
  searchGyms: GymConnection;
};

/**
 * Exactly the fields SEARCH_GYMS_DIRECTORY selects — the directory card
 * contract. `boardSummaries` is re-declared as required: it's optional on the
 * shared `Gym` because the GYM_FIELDS documents don't select it, but this
 * document does, so a card consumer shouldn't have to null-check it.
 */
export type GymDirectoryCard = Pick<
  Gym,
  'uuid' | 'slug' | 'name' | 'address' | 'latitude' | 'longitude' | 'isClaimed'
> & {
  boardSummaries: GymBoardSummary[];
};

export type SearchGymsDirectoryQueryVariables = {
  input: SearchGymsInput;
};

export type SearchGymsDirectoryQueryResponse = {
  searchGyms: {
    gyms: GymDirectoryCard[];
    totalCount: number;
  };
};

export type FindSimilarGymsQueryVariables = {
  input: FindSimilarGymsInput;
};

export type FindSimilarGymsQueryResponse = {
  findSimilarGyms: SimilarGym[];
};

export type GetGymMembersQueryVariables = {
  input: GymMembersInput;
};

export type GetGymMembersQueryResponse = {
  gymMembers: GymMemberConnection;
};

export type GetGymBoardsQueryVariables = {
  gymUuid: string;
};

export type GetGymBoardsQueryResponse = {
  gymBoards: UserBoard[];
};

export type StrayBoardsForGymQueryVariables = {
  gymUuid: string;
};

export type StrayBoardsForGymQueryResponse = {
  strayBoardsForGym: StrayBoard[];
};

export type GetGymStatsQueryVariables = {
  input: GymStatsInput;
};

export type GetGymStatsQueryResponse = {
  gymStats: GymStats;
};

export type CreateGymMutationVariables = {
  input: CreateGymInput;
};

export type CreateGymMutationResponse = {
  createGym: Gym;
};

export type UpdateGymMutationVariables = {
  input: UpdateGymInput;
};

export type UpdateGymMutationResponse = {
  updateGym: Gym;
};

export type DeleteGymMutationVariables = {
  gymUuid: string;
};

export type DeleteGymMutationResponse = {
  deleteGym: boolean;
};

export type AddGymMemberMutationVariables = {
  input: AddGymMemberInput;
};

export type AddGymMemberMutationResponse = {
  addGymMember: boolean;
};

export type RemoveGymMemberMutationVariables = {
  input: RemoveGymMemberInput;
};

export type RemoveGymMemberMutationResponse = {
  removeGymMember: boolean;
};

export type FollowGymMutationVariables = {
  input: FollowGymInput;
};

export type FollowGymMutationResponse = {
  followGym: boolean;
};

export type UnfollowGymMutationVariables = {
  input: FollowGymInput;
};

export type UnfollowGymMutationResponse = {
  unfollowGym: boolean;
};

export type LinkBoardToGymMutationVariables = {
  input: LinkBoardToGymInput;
};

export type LinkBoardToGymMutationResponse = {
  linkBoardToGym: boolean;
};

export type AttachBoardToGymMutationVariables = {
  input: AttachBoardToGymInput;
};

export type AttachBoardToGymMutationResponse = {
  attachBoardToGym: boolean;
};

export type GrantGymWriteAccessMutationVariables = {
  input: GrantGymWriteAccessInput;
};

export type GrantGymWriteAccessMutationResponse = {
  grantGymWriteAccess: boolean;
};

export type RevokeGymWriteAccessMutationVariables = {
  input: RevokeGymWriteAccessInput;
};

export type RevokeGymWriteAccessMutationResponse = {
  revokeGymWriteAccess: boolean;
};

export type RequestGymClaimMutationVariables = {
  input: RequestGymClaimInput;
};

export type RequestGymClaimMutationResponse = {
  requestGymClaim: RequestGymClaimResult;
};

export type ReviewGymClaimMutationVariables = {
  input: ReviewGymClaimInput;
};

export type ReviewGymClaimMutationResponse = {
  reviewGymClaim: boolean;
};

export type PendingGymClaimsQueryVariables = {
  input?: PendingGymClaimsInput;
};

export type PendingGymClaimsQueryResponse = {
  pendingGymClaims: GymClaimConnection;
};

export type DuplicateGymClustersQueryVariables = {
  input?: DuplicateGymClustersInput;
};

export type DuplicateGymClustersQueryResponse = {
  duplicateGymClusters: DuplicateGymClusterConnection;
};

export type OrphanGymsQueryVariables = {
  input?: OrphanGymsInput;
};

export type OrphanGymsQueryResponse = {
  orphanGyms: OrphanGymConnection;
};

export type MergeGymsMutationVariables = {
  input: MergeGymsInput;
};

export type MergeGymsMutationResponse = {
  mergeGyms: MergeGymsResult;
};

export type DismissGymClusterMutationVariables = {
  input: DismissGymClusterInput;
};

export type DismissGymClusterMutationResponse = {
  dismissGymCluster: boolean;
};

export type ReportGymDuplicateMutationVariables = {
  input: ReportGymDuplicateInput;
};

export type ReportGymDuplicateMutationResponse = {
  reportGymDuplicate: ReportGymDuplicateResult;
};
