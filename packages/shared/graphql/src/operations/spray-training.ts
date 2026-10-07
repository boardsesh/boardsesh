import { gql } from 'graphql-request';
import type {
  SprayHoldAutoReview,
  SprayHoldSource,
  SprayTrainingCandidateFate,
  SprayTrainingRejectReason,
  SprayTrainingReviewStatus,
  SprayTrainingWallVisibility,
} from '../generated/graphql';
import type { SprayWallPhotoData } from './spray-walls';

export type {
  SprayHoldAutoReview,
  SprayTrainingCandidateFate,
  SprayTrainingRejectReason,
  SprayTrainingReviewStatus,
  SprayTrainingWallVisibility,
} from '../generated/graphql';

/**
 * Spray wall training data (SW-20, #5471): the owner's "Help train hold
 * finding" switch, and the admin vetting queue behind web `/admin/spray-walls`.
 *
 * The consent field has its own query and mutation selection rather than a
 * place in `SPRAY_WALL_FIELDS`, for the reason `GET_SPRAY_WALL_LOOK` gives: a
 * field the backend does not serve fails validation for the WHOLE operation, so
 * putting it in the shared fragment would break loading every wall on a backend
 * that predates it. Out here, an older backend costs only the switch.
 *
 * The queue's photo URLs are 15-minute presigned signatures over the PRIVATE
 * bucket, like every spray wall photo: re-run the query after
 * `photo.expiresAt`, never store the URL.
 */

// ============================================
// Owner consent
// ============================================

/** The owner's switch. `trainingConsent` is null for anybody but the owner. */
export const GET_SPRAY_WALL_TRAINING_CONSENT = gql`
  query GetSprayWallTrainingConsent($uuid: ID!) {
    sprayWall(uuid: $uuid) {
      uuid
      trainingConsent
    }
  }
`;

export type GetSprayWallTrainingConsentQueryVariables = { uuid: string };
export type GetSprayWallTrainingConsentQueryResponse = {
  sprayWall: { uuid: string; trainingConsent?: boolean | null } | null;
};

/**
 * Flip the switch through `updateSprayWall`. Owner only, like visibility; the
 * server refuses anybody else with `SPRAY_WALL_VISIBILITY_OWNER_ONLY`'s code.
 * Selects only the switch, for the reason given above.
 */
export const SET_SPRAY_WALL_TRAINING_CONSENT = gql`
  mutation SetSprayWallTrainingConsent($input: UpdateSprayWallInput!) {
    updateSprayWall(input: $input) {
      uuid
      trainingConsent
    }
  }
`;

export type SetSprayWallTrainingConsentMutationVariables = {
  input: { uuid: string; trainingConsent: boolean };
};
export type SetSprayWallTrainingConsentMutationResponse = {
  updateSprayWall: { uuid: string; trainingConsent?: boolean | null };
};

// ============================================
// Admin vetting queue
// ============================================

const SPRAY_TRAINING_REVIEW_FIELDS = `
  status
  reason
  notes
  reviewedAt
`;

/** One page of the queue. Community admins only (`spray`-scoped or global). */
export const GET_SPRAY_TRAINING_QUEUE = gql`
  query GetSprayTrainingQueue($status: SprayTrainingReviewStatus!, $limit: Int, $offset: Int) {
    sprayTrainingQueue(status: $status, limit: $limit, offset: $offset) {
      hasMore
      totals {
        unreviewed
        approved
        rejected
      }
      items {
        versionId
        wallUuid
        versionNumber
        visibility
        createdAt
        publishedAt
        photo {
          url
          thumbUrl
          width
          height
          expiresAt
        }
        photoWidth
        photoHeight
        holds {
          id
          cx
          cy
          r
          outline
          source
          autoReview
          confidence
        }
        unmappableHoldCount
        candidates {
          index
          cx
          cy
          r
          confidence
          outline
          fate
        }
        detectionModelVersion
        stats {
          holdCount
          manualHoldCount
          autoHoldCount
          acceptedHoldCount
          confirmedHoldCount
          editedHoldCount
          candidateCount
          keptCandidateCount
          editedCandidateCount
          deletedCandidateCount
          notShownCandidateCount
        }
        review {
          ${SPRAY_TRAINING_REVIEW_FIELDS}
        }
      }
    }
  }
`;

/** Approve, reject (with a reason) or clear the verdict on one version. */
export const SET_SPRAY_TRAINING_REVIEW = gql`
  mutation SetSprayTrainingReview($input: SetSprayTrainingReviewInput!) {
    setSprayTrainingReview(input: $input) {
      versionId
      review {
        ${SPRAY_TRAINING_REVIEW_FIELDS}
      }
    }
  }
`;

export type SprayTrainingReviewData = {
  status: SprayTrainingReviewStatus;
  reason: SprayTrainingRejectReason | null;
  notes: string | null;
  reviewedAt: string | null;
};

/** A saved hold in the version's PHOTO pixels; `outline` is in units of `r`. */
export type SprayTrainingHoldData = {
  id: number;
  cx: number;
  cy: number;
  r: number;
  outline: number[] | null;
  source: SprayHoldSource;
  autoReview: SprayHoldAutoReview | null;
  confidence: number | null;
};

/** A detector suggestion in photo pixels; `outline` is in units of `r`. */
export type SprayTrainingCandidateData = {
  index: number;
  cx: number;
  cy: number;
  r: number;
  confidence: number;
  outline: number[] | null;
  fate: SprayTrainingCandidateFate;
};

export type SprayTrainingStatsData = {
  holdCount: number;
  manualHoldCount: number;
  autoHoldCount: number;
  acceptedHoldCount: number;
  confirmedHoldCount: number;
  editedHoldCount: number;
  candidateCount: number;
  keptCandidateCount: number;
  editedCandidateCount: number;
  deletedCandidateCount: number;
  notShownCandidateCount: number;
};

export type SprayTrainingQueueItemData = {
  versionId: string;
  wallUuid: string;
  versionNumber: number;
  visibility: SprayTrainingWallVisibility;
  createdAt: string;
  publishedAt: string | null;
  photo: SprayWallPhotoData | null;
  photoWidth: number | null;
  photoHeight: number | null;
  holds: SprayTrainingHoldData[];
  unmappableHoldCount: number;
  candidates: SprayTrainingCandidateData[];
  detectionModelVersion: string | null;
  stats: SprayTrainingStatsData;
  review: SprayTrainingReviewData;
};

export type GetSprayTrainingQueueQueryVariables = {
  status: SprayTrainingReviewStatus;
  limit?: number | null;
  offset?: number | null;
};

export type GetSprayTrainingQueueQueryResponse = {
  sprayTrainingQueue: {
    hasMore: boolean;
    totals: { unreviewed: number; approved: number; rejected: number };
    items: SprayTrainingQueueItemData[];
  };
};

export type SetSprayTrainingReviewMutationVariables = {
  input: {
    versionId: string;
    status: SprayTrainingReviewStatus;
    reason?: SprayTrainingRejectReason | null;
    notes?: string | null;
  };
};

export type SetSprayTrainingReviewMutationResponse = {
  setSprayTrainingReview: { versionId: string; review: SprayTrainingReviewData };
};
