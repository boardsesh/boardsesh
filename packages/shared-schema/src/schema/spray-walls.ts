export const sprayWallsTypeDefs = /* GraphQL */ `
  """
  Lifecycle of one wall photo.

  DRAFT is being edited and is invisible to climbers; PUBLISHED is the generation
  climbs are set against; SUPERSEDED is what the previous PUBLISHED becomes when a
  reset commits (SW-12).
  """
  enum SprayWallVersionStatus {
    DRAFT
    PUBLISHED
    SUPERSEDED
  }

  "Where a hold's geometry came from: a detector run, or a human's hand."
  enum SprayHoldSource {
    MANUAL
    AUTO
  }

  """
  A wall photo, behind short-lived presigned URLs.

  Spray-wall photos live in the PRIVATE bucket, never the public \`media\` one:
  the photograph is of somebody's home, and \`media\` is world-readable under
  guessable keys (\`docs/user-media-storage.md\`). So there is no stable URL to
  store on a row — every read mints a fresh signature, and \`expiresAt\` is when
  the one in hand stops working.
  """
  type SprayWallPhoto {
    "Presigned GET for the full-size photo. Valid until expiresAt; never cache it past that."
    url: String!
    "Presigned GET for the largest stored resize variant, for list rows and the compare view."
    thumbUrl: String
    "Pixel width of the stored photo, after sharp's EXIF-orientation rotate."
    width: Int
    "Pixel height of the stored photo, after sharp's EXIF-orientation rotate."
    height: Int
    "ISO 8601 expiry of the signatures above."
    expiresAt: String!
  }

  """
  One hold across its whole life. Coordinates are in the wall's canonical frame
  (\`SprayWall.referenceWidth\` / \`referenceHeight\`), which version 1 defines from
  its own photo — there are no real-world wall dimensions anywhere.
  """
  type SprayWallHold {
    "The wall's board_placements id AND its board_holes id — the number a climb's frames string carries."
    id: Int!
    cx: Int!
    cy: Int!
    r: Int!
    "Flat implicitly-closed ring [x0, y0, x1, y1, ...] in units of this hold's own radius, relative to its centre. Null falls back to the circle (cx, cy, r) describes."
    outline: [Float!]
    "Version number that put this hold on the wall."
    installedVersion: Int!
    "Version number that took it off, or null while it is still there."
    removedVersion: Int
    "The hold this one replaced, when a reset review linked a move."
    movedFromHoldId: Int
    source: SprayHoldSource!
    "Detector confidence 0-1 for AUTO holds; null when a human drew it."
    confidence: Float
  }

  "One photograph of the wall, with the geometry that maps it onto the canonical frame."
  type SprayWallVersion {
    id: ID!
    "1-based and dense per wall."
    number: Int!
    status: SprayWallVersionStatus!
    """
    The photo, or null when it cannot be served right now.

    Nullable rather than required even though every version is created WITH a
    photo: the URLs are minted per read, so a backend with no \`private\` bucket
    configured — or a row whose key was cleared by hand — has nothing to hand back.
    Non-null here would turn that into a hard error on the whole \`versions\` list
    instead of one absent photo, which is the wrong failure for a field a client
    already has to re-fetch when it expires.
    """
    photo: SprayWallPhoto
    "The wall's four corners in THIS photo's pixels, TL/TR/BR/BL, as [[x, y], ...]. Null means the photo frame is the quad."
    anchors: JSON
    """
    Row-major 3x3 photo→canonical homography, nine floats.

    The IDENTITY matrix when no anchors were solved for this version — either none
    were tapped, or the four that were do not describe a usable quadrilateral. Null
    only for a row written before the homography existed; treat null as the identity.
    """
    homography: [Float!]
    "What changed in this reset, in the wall owner's own words."
    notes: String
    publishedAt: String
    createdAt: String!
    "Holds this version put on the wall."
    addedHoldCount: Int!
    "Holds this version took off the wall."
    removedHoldCount: Int!
  }

  """
  A climber's own wall: one runtime-created catalogue layout under the \`spray\`
  board type. Its owner, name, angle, visibility and gym live on the
  \`user_boards\` row \`board\` returns — nothing about a wall is stored twice.
  """
  type SprayWall {
    uuid: ID!
    board: UserBoard!
    "The wall's board_layouts id. Also its board_product_sizes id: a wall has exactly one size, itself."
    layoutId: Int!
    "Always equal to layoutId. Returned so a client never has to know the equality."
    sizeId: Int!
    "The canonical frame in pixels, derived from the version-1 photo. Null until the first photo lands."
    referenceWidth: Int
    referenceHeight: Int
    "The published version climbers see. Null until the first publish."
    currentVersion: SprayWallVersion
    "Every version, newest first. Drafts are only visible to the owner."
    versions: [SprayWallVersion!]!
    "Holds alive on the current version."
    holdCount: Int!
    """
    Whether the viewer may edit this wall's holds and photos.

    True for the owner, and — because the rule is \`requireBoardEditAccess\`
    unchanged — also for the owner or an admin of the gym the wall is attached to,
    and for a community admin/leader on a PUBLIC wall. A gym \`editor\` is not among
    them: they can edit the gym's page and not a wall's holds.
    """
    viewerCanEdit: Boolean!
  }

  """
  Everything a renderer needs for one wall at one version: the photo, the
  geometry that maps it, and the holds alive at that version.

  No image is ever warped — the client maps holds through the INVERSE of
  \`homography\` at draw time.
  """
  type SprayWallRenderData {
    wall: SprayWall!
    versionNumber: Int!
    "The canonical frame's width, i.e. the coordinate space cx/cy/r live in."
    boardWidth: Int!
    "The canonical frame's height."
    boardHeight: Int!
    photo: SprayWallPhoto!
    homography: [Float!]!
    holds: [SprayWallHold!]!
  }

  input CreateSprayWallInput {
    "What the climber calls the wall. Becomes the board name, the catalogue row names and the slug."
    name: String!
    "Fixed for the wall's life: stats are keyed by angle and a spray wall does not adjust."
    angle: Int!
    description: String
    "Private by default. A public wall is listed; an unlisted one is reachable by uuid only."
    isPublic: Boolean
    isUnlisted: Boolean
    "Attach the wall to a gym the caller may link boards to."
    gymUuid: ID
    locationName: String
    latitude: Float
    longitude: Float
    hideLocation: Boolean
  }

  input CreateSprayWallVersionInput {
    wallUuid: ID!
    "photoId from POST /api/spray-wall-photos."
    photoId: ID!
    "The wall's four corners in this photo's pixels, TL/TR/BR/BL, as [[x, y], ...]. Omit to use the photo frame."
    anchors: JSON
    notes: String
  }

  """
  One hold as the editor sends it. Coordinates are canonical-frame pixels.

  \`id\` names an existing hold on the wall (a geometry correction); omit it and
  the server allocates a new catalogue id. The server validates SHAPE only — the
  ring contract, the caps and that an id is alive on the version — and never
  re-runs detection: it is the owner's wall.
  """
  input SprayWallHoldInput {
    id: Int
    cx: Int!
    cy: Int!
    r: Int!
    "Flat implicitly-closed ring in radius units, 3-150 points, every coordinate within 4 radii."
    outline: [Float!]
    source: SprayHoldSource
    confidence: Float
    movedFromHoldId: Int
  }

  input UpsertSprayWallHoldsInput {
    wallUuid: ID!
    "The DRAFT version being edited. Published versions are immutable."
    versionId: ID!
    holds: [SprayWallHoldInput!]!
  }

  input RemoveSprayWallHoldsInput {
    wallUuid: ID!
    versionId: ID!
    holdIds: [Int!]!
  }

  input PublishSprayWallVersionInput {
    versionId: ID!
  }

  input UpdateSprayWallInput {
    uuid: ID!
    name: String
    description: String
    """
    Make the wall world-readable. This is the switch that turns a private wall into
    a shared one, so it is also what starts publishing its climbs to feeds.
    """
    isPublic: Boolean
    "Reachable by uuid — the share link — and listed nowhere."
    isUnlisted: Boolean
    "Attach the wall to a gym the caller may link boards to, or pass null to detach."
    gymUuid: ID
    """
    Correct the wall's angle.

    Only while the wall has NO published version — stats are keyed by angle, so
    moving it afterwards would orphan every tick and stat already recorded. Rejected
    rather than cascaded.
    """
    angle: Int
  }
`;

export const sprayWallResetTypeDefs = /* GraphQL */ `
  """
  One hold the client found in the NEW photo, already mapped through that photo's
  homography into the wall's canonical frame.

  The server never re-runs detection on these (epic decision 2026-09-14): it is
  the owner's wall. What it does with them is match them against the holds that
  are on the wall today, which is a question about two coordinate sets and not
  about whether a blob is a hold.
  """
  input SprayWallDetectionInput {
    cx: Int!
    cy: Int!
    r: Int!
    "Flat implicitly-closed ring in radius units, same contract as SprayWallHold.outline."
    outline: [Float!]
    """
    Optional colour descriptor (a Lab triple, or Lab plus a hue histogram).

    **Accepted and currently ignored.** The matcher can only compare colours when
    BOTH sides carry a descriptor of the same length, and the holds already on the
    wall carry none — \`spray_wall_holds\` has nowhere to put one. So a reset today
    is decided on geometry alone, whatever is sent here. The field stays so a
    client need not change when SW-12b (#5485) gives a stored hold a descriptor.
    """
    colour: [Float!]
    source: SprayHoldSource
    confidence: Float
  }

  input ProposeSprayWallResetInput {
    wallUuid: ID!
    """
    The DRAFT version whose photo these detections came from.

    It must carry anchors: the canonical frame is version 1's photo frame forever,
    so from version 2 on the four corners are the only thing that says where this
    photograph's pixels sit in it.
    """
    versionId: ID!
    "Every hold found in the new photo, in the wall's canonical frame."
    detections: [SprayWallDetectionInput!]!
  }

  "A hold the matcher believes is still on the wall, and which detection it matched."
  type SprayWallResetKeptHold {
    holdId: Int!
    "Index into the \`detections\` array that was submitted."
    detectionIndex: Int!
    "1 - match cost, clamped to 0..1. 1 is a perfect overlap of identical colours."
    confidence: Float!
  }

  """
  A removed hold paired with the nearest added detection.

  Strictly a suggestion — the proposal still reports the pair as one removal and
  one addition, because a hold that moved is not the hold a climb used any more.
  Confirming one writes \`movedFromHoldId\` so remix can offer the successor.
  """
  type SprayWallMoveSuggestion {
    movedFromHoldId: Int!
    detectionIndex: Int!
    "Centre-to-centre distance in canonical pixels."
    distance: Float!
  }

  """
  What a reset would do, computed and thrown away. \`proposeSprayWallReset\`
  writes nothing at all — the owner reviews this and \`commitSprayWallVersion\`
  is what lands it.
  """
  type SprayWallResetProposal {
    "The draft version number the proposal was computed against."
    versionNumber: Int!
    kept: [SprayWallResetKeptHold!]!
    "Hold ids with no detection inside the gates: these came off the wall."
    removed: [Int!]!
    "Indices into \`detections\` that matched nothing already on the wall."
    added: [Int!]!
    "Kept hold ids a human should look at — a second detection was nearly as good a match."
    lowConfidence: [Int!]!
    "How many climbs on this wall use at least one of the removed holds."
    climbsAffected: Int!
    movesSuggested: [SprayWallMoveSuggestion!]!
    """
    The new photo's aspect ratio differs from the wall's canonical frame by more
    than a tenth.

    A WARNING and never a block (epic decision 2026-09-14). A phone held the other
    way up, or a step back from the wall, changes the framing without changing the
    wall — the anchors are what put the two photos in one frame, and they have
    already been applied by the time these detections arrive.
    """
    aspectMismatch: Boolean!
  }

  "Keep this hold, optionally refreshing its silhouette from the new photo."
  input SprayWallKeptDecisionInput {
    holdId: Int!
    """
    The detection this hold matched.

    Only the OUTLINE is taken from it. \`cx\` / \`cy\` / \`r\` stay exactly as
    published: every climb on the wall renders from those numbers, so nudging a
    kept hold by the few pixels two photographs disagree by would move the climbs
    with it. A silhouette is a picture of the hold, not a position, so a sharper
    one from the newer photo is free.
    """
    detection: SprayWallDetectionInput
  }

  "Put this detection on the wall as a new hold, with a new catalogue id."
  input SprayWallAddedDecisionInput {
    detection: SprayWallDetectionInput!
    """
    The hold this one replaced, when the review confirmed a move.

    It has to be in this commit's \`removed\` list: a move is one removal and one
    addition in the same reset. A predecessor that is still on the wall, or one an
    earlier reset already took off, is refused — either would leave remix offering
    an unrelated hold as a successor, with nothing to notice it afterwards.
    """
    movedFromHoldId: Int
  }

  """
  The reviewed outcome of a reset. Re-validated against the wall's current state
  inside the commit transaction — a proposal computed ten minutes ago against a
  generation that has since been published is rejected, not applied.
  """
  input CommitSprayWallVersionInput {
    wallUuid: ID!
    "The DRAFT version this reset lands as. It must carry anchors (see ProposeSprayWallResetInput)."
    versionId: ID!
    kept: [SprayWallKeptDecisionInput!]!
    "Hold ids that came off the wall."
    removed: [Int!]!
    added: [SprayWallAddedDecisionInput!]!
  }

  "What a committed reset changed."
  type SprayWallResetResult {
    "The version, now PUBLISHED."
    version: SprayWallVersion!
    """
    Holds still on the wall from the previous generation.

    The holds that were alive minus the ones this commit removed — NOT the length
    of the \`kept\` list. An alive hold the decisions never mention simply stays,
    so a client that lists only the holds it had something to say about would
    otherwise be told most of its wall had vanished.
    """
    keptCount: Int!
    "Holds this commit took off the wall."
    removedCount: Int!
    "Holds this commit put on the wall."
    addedCount: Int!
    "Climbs whose \`missingHoldCount\` moved as a result."
    climbsChanged: Int!
  }

  """
  A remix starting point: the parent climb with every hold it has since lost
  stripped out of its frames.

  Nothing is written by asking for one. Pass \`parentUuid\` back as
  \`SaveClimbInput.remixOfClimbUuid\` and the lineage row is written with the
  child.
  """
  type SprayRemixSeed {
    "The climb being remixed."
    parentUuid: ID!
    parentName: String!
    layoutId: Int!
    angle: Int!
    "The parent's frames with the lost holds removed. Empty when nothing survived."
    frames: String!
    "Holds the parent used that are no longer on the wall."
    lostHoldIds: [Int!]!
    "Holds of the parent that are still there."
    keptHoldIds: [Int!]!
    """
    Successors the reset review linked for the lost holds, nearest first.

    A remix wants somewhere to start, and \`moved_from_hold_id\` is the only
    record of which of today's holds replaced one of yesterday's.
    """
    suggestedHoldIds: [Int!]!
  }
`;
