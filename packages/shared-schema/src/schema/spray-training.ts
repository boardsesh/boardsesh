/**
 * Spray wall training data (SW-20, #5471): the admin vetting queue over wall
 * versions whose owners left "Help train hold finding" on, and the scheduler's
 * export of the approved ones. See `docs/spray-walls.md`, "Training data".
 */
export const sprayTrainingTypeDefs = /* GraphQL */ `
  "An admin's verdict on one wall version as training data. UNREVIEWED is the absence of one."
  enum SprayTrainingReviewStatus {
    UNREVIEWED
    APPROVED
    REJECTED
  }

  "Why a version was kept out of the training set. A closed set; notes carry anything else."
  enum SprayTrainingRejectReason {
    "Holds are drawn in the wrong place or the wrong shape."
    BAD_HOLDS
    "Real holds on the wall were never marked."
    MISSING_HOLDS
    "Blurred, dark, cropped or too angled to learn from."
    PHOTO_QUALITY
    "Not a climbing wall."
    NOT_A_WALL
    "A person, a face, an address or documents are in the frame."
    PEOPLE_OR_PERSONAL_INFO
    "The same wall and photo is already in the set."
    DUPLICATE
    OTHER
  }

  """
  What happened to one detector suggestion.

  KEPT: a saved hold came from it and its shape was not changed. EDITED: a saved
  hold came from it and the climber changed its shape. DELETED: the editor
  showed it and no saved hold came from it. NOT_SHOWN: it scored below the
  editor's floor, so the climber never saw it. UNKNOWN: no hold on the version
  records where it came from (it was saved by an app that predates provenance),
  so kept and deleted cannot be told apart.
  """
  enum SprayTrainingCandidateFate {
    KEPT
    EDITED
    DELETED
    NOT_SHOWN
    UNKNOWN
  }

  "Who can see the wall a version belongs to."
  enum SprayTrainingWallVisibility {
    PUBLIC
    UNLISTED
    PRIVATE
  }

  "One saved hold, projected into the version's PHOTO pixels."
  type SprayTrainingHold {
    id: Int!
    cx: Float!
    cy: Float!
    r: Float!
    "Flat implicitly-closed ring in units of THIS (projected) radius, relative to the centre. Null draws the circle."
    outline: [Float!]
    source: SprayHoldSource!
    autoReview: SprayHoldAutoReview
    confidence: Float
  }

  """
  One suggestion, in photo pixels, from the detector run the version is judged
  against: the finished run on its photo that the most of its holds point back
  at, or the newest finished run on that photo when no hold points at any.
  """
  type SprayTrainingCandidate {
    "Index into the run's result.candidates."
    index: Int!
    cx: Float!
    cy: Float!
    r: Float!
    confidence: Float!
    "Flat ring in units of r relative to the centre, as the detector sent it."
    outline: [Float!]
    fate: SprayTrainingCandidateFate!
  }

  type SprayTrainingStats {
    holdCount: Int!
    manualHoldCount: Int!
    autoHoldCount: Int!
    "AUTO holds kept as found (accept-defaults or keep-maybes)."
    acceptedHoldCount: Int!
    "AUTO holds the climber switched on one at a time."
    confirmedHoldCount: Int!
    "AUTO holds whose shape the climber changed."
    editedHoldCount: Int!
    candidateCount: Int!
    keptCandidateCount: Int!
    editedCandidateCount: Int!
    deletedCandidateCount: Int!
    notShownCandidateCount: Int!
  }

  type SprayTrainingReview {
    status: SprayTrainingReviewStatus!
    reason: SprayTrainingRejectReason
    notes: String
    reviewedAt: String
  }

  """
  One wall version in the vetting queue. Carries no owner name and no wall name:
  the reviewer judges the photo and the holds, not the person.
  """
  type SprayTrainingQueueItem {
    versionId: ID!
    wallUuid: ID!
    versionNumber: Int!
    visibility: SprayTrainingWallVisibility!
    createdAt: String!
    publishedAt: String
    "Admin-only presigned photo; re-query after photo.expiresAt. Null when it cannot be signed."
    photo: SprayWallPhoto
    photoWidth: Int
    photoHeight: Int
    "Alive holds of this version in photo pixels."
    holds: [SprayTrainingHold!]!
    """
    Holds whose canonical position does not project onto the photo, so they are
    not in holds. A version with any is left out of the export even when
    approved: a real hold missing from the labels would be learned as background.
    """
    unmappableHoldCount: Int!
    candidates: [SprayTrainingCandidate!]!
    "Model version of the detector run candidates come from, or null when the version has none."
    detectionModelVersion: String
    stats: SprayTrainingStats!
    review: SprayTrainingReview!
  }

  type SprayTrainingTotals {
    unreviewed: Int!
    approved: Int!
    rejected: Int!
  }

  type SprayTrainingQueue {
    items: [SprayTrainingQueueItem!]!
    hasMore: Boolean!
    "Eligible versions per status, over the whole queue rather than this page."
    totals: SprayTrainingTotals!
  }

  input SetSprayTrainingReviewInput {
    versionId: ID!
    "UNREVIEWED clears the verdict."
    status: SprayTrainingReviewStatus!
    "Required with REJECTED, refused otherwise."
    reason: SprayTrainingRejectReason
    "At most 500 characters."
    notes: String
  }

  type SprayTrainingReviewResult {
    versionId: ID!
    review: SprayTrainingReview!
  }

  "Why an export run wrote nothing."
  enum SprayTrainingExportSkipReason {
    "Another run holds the export lease. The scheduler job reports this as a failure."
    LOCKED
    "The approved, eligible set matches the newest export."
    UNCHANGED
    "Nothing is approved and eligible, or nothing approved could be exported."
    NOTHING_TO_EXPORT
  }

  "What one export run did."
  type SprayTrainingExportResult {
    "The export written on this run, or null when nothing changed or nothing is approved."
    exportId: String
    imagesWritten: Int!
    "Stored exports deleted because a version in them is no longer eligible and approved, or they fell out of the newest two."
    exportsRetired: Int!
    "True when nothing was written; skippedReason says why."
    skipped: Boolean!
    skippedReason: SprayTrainingExportSkipReason
    "Approved, eligible versions left out of this export: holds that do not project onto the photo, no holds, or an unreadable photo."
    versionsSkipped: Int!
    durationMs: Int!
  }

  extend type Query {
    """
    Wall versions eligible as training data, by review status, oldest first.
    Community admins only (\`spray\`-scoped or global). At most 25 per page.
    """
    sprayTrainingQueue(status: SprayTrainingReviewStatus!, limit: Int, offset: Int): SprayTrainingQueue!
  }

  extend type Mutation {
    """
    Approve, reject or clear the verdict on one version. Community admins only
    (\`spray\`-scoped or global). Refused for a version that is not eligible.
    """
    setSprayTrainingReview(input: SetSprayTrainingReviewInput!): SprayTrainingReviewResult!

    """
    Retire stale exports and write a new one of every approved, eligible version
    to the private bucket. Cron-authenticated; the scheduler's
    \`export-spray-training\` job is the only caller.
    """
    exportSprayTrainingDataset: SprayTrainingExportResult!
  }
`;
