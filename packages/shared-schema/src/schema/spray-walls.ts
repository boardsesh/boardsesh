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
  What the climber did with a detector suggestion before saving it as an AUTO
  hold. Ranked ACCEPTED < CONFIRMED < EDITED; a hold never moves down.
  """
  enum SprayHoldAutoReview {
    "Kept as found, through accept-defaults or keep-maybes."
    ACCEPTED
    "A maybe the climber switched on by itself."
    CONFIRMED
    "Its shape changed after the detector drew it. The server also sets this whenever an AUTO hold's geometry moves."
    EDITED
  }

  """
  Retired. A published spray climb follows the rule every board follows: only
  its setter edits it, within 24 hours of first publish. Every wall reads SETTER.
  """
  enum SprayClimbEditPolicy {
    SETTER
    COLLABORATORS @deprecated(reason: "Retired. Only a climb's setter edits it, within 24 hours of first publish.")
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
    "What the climber did with the suggestion. Null for MANUAL holds and for AUTO holds saved without provenance."
    autoReview: SprayHoldAutoReview
    "The detection run the suggestion came from. Null for MANUAL holds."
    originDetectionId: ID
    "Index of the suggestion in that run's result.candidates."
    originCandidateIndex: Int
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
    # Public identity is the owning UserBoard.uuid, also returned as board.uuid.
    # The separate spray_walls.id is an internal numeric key, never a capability.
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
    A stable, unsigned URL for the wall photo — public walls only, null for every
    other wall.

    A public wall has to show up on a web gym page that a logged-out climber
    reads, and nobody there can hold a fifteen-minute signature. So going public
    COPIES the current photo into the world-readable \`media\` bucket under an
    unguessable random key and serves that; going private deletes the object and
    nulls this. Null on a public wall means nothing has been published yet, or the
    copy has not been made.
    """
    publicPhotoUrl: String

    """
    Whether the viewer may edit this wall's holds and photos.

    True for the owner, and — because the rule is \`requireBoardEditAccess\`
    unchanged — also for the owner or an admin of the gym the wall is attached to,
    and for a community admin/leader on a PUBLIC wall. A gym \`editor\` is not among
    them: they can edit the gym's page and not a wall's holds.
    """
    viewerCanEdit: Boolean!
    "Always SETTER: only a climb's setter edits it, within 24 hours of first publish."
    climbEditPolicy: SprayClimbEditPolicy!
      @deprecated(reason: "Retired. Only a climb's setter edits it, within 24 hours of first publish.")
    """
    Always false. Editing someone else's published climb on a wall was retired;
    the setter's own edit rights come from the climb, not the wall.
    """
    viewerCanEditClimbs: Boolean!
      @deprecated(reason: "Retired. Only a climb's setter edits it, within 24 hours of first publish.")
    """
    When an admin hid this wall, ISO 8601, or null for the overwhelmingly common
    case.

    Only ever non-null for the wall's OWNER: a hidden wall reads exactly like a
    private one to everybody else, so nobody else can resolve it to ask. The
    owner's app shows a notice off this field — a wall that vanished without a
    word would look like data loss.
    """
    hiddenAt: String
    """
    The wall's own stored default look, or null when its creator never set one
    (including every wall created before this field existed). A
    \`{ mode: 'classic' | 'aura', boardsesh: {...} }\` blob, opaque to the schema
    and validated server-side — kept as JSON rather than a parallel GraphQL type
    because the underlying knob set still changes independently. A viewer's own
    EXPLICIT render-mode choice always overrides this; it only supplies the look
    for a viewer who has never chosen one.

    May also carry \`background: 'photo' | 'wall-crop' | 'hold-cutouts'\` — what
    the wall is drawn on. Missing means 'photo'. The generated backgrounds are
    read through \`sprayWallArt\`; a client falls back to the photo whenever that
    art is not READY.
    """
    renderSettings: JSON
    """
    When this wall was archived, ISO 8601, or null for a live wall.

    A wall is archived when a reset clone of it (\`resetSprayWall\`) reaches its
    first publish. An archived wall is read-only: its climbs, ticks, playlists
    and share links keep working, it leaves every board picker and listing, and
    nobody can set a new climb, edit a climb or change its holds on it.
    """
    archivedAt: String
    """
    The wall this one was cloned from by \`resetSprayWall\`. Only for a viewer who
    can see that wall without its uuid: its owner, a member of its gym, or anyone
    when it is public.
    """
    resetOfWallUuid: ID
    """
    The published wall that replaced this one through \`resetSprayWall\`, when the
    viewer may see it: its owner, a member of its gym, anyone when it is public,
    or anyone holding this wall's share link when this wall is unlisted and not
    public and the replacement is unlisted too. Null while the replacement is
    unfinished.
    """
    replacedByWallUuid: ID
    """
    Whether the owner lets this wall's photo and marked holds help train hold
    finding. The app turns it on for a new wall unless the owner switches it
    off. A wall that existed before the switch, or was created without stating
    it, starts off. A Boardsesh admin checks a version before it is used. Only
    ever non-null for the wall's OWNER.
    """
    trainingConsent: Boolean
  }

  "Where a version's generated wall looks are."
  enum SprayWallArtStatus {
    "Never asked for, or made by an older recipe."
    NONE
    "A job is queued or running."
    PENDING
    "Both images are ready."
    READY
    "The last job failed. Choosing a generated background again re-queues it."
    FAILED
    "The photo failed the quality gate, so nothing will be rendered for it."
    REFUSED
  }

  enum SprayWallPhotoVerdict {
    "Front-on enough to flatten cleanly."
    GOOD
    "Usable, but the far side will look stretched; suggest a front-on retake."
    SOFT
    "Too angled, too small, or no corner pins: the generated looks are not offered."
    FAIL
  }

  "How straight-on a version's photo is. Same numbers on the server and in the app."
  type SprayWallPhotoQuality {
    "sqrt(max / min) of the area scale across the frame. 1 is a perfectly front-on photo. Null when unmeasurable."
    stretch: Float
    verdict: SprayWallPhotoVerdict!
    "ok, no-pins, keystone, small-frame or singular."
    reason: String!
    "The canonical frame's short edge, in pixels."
    frameShortEdge: Int!
  }

  """
  One version's generated wall looks, drawn in the canonical frame (the frame
  hold coordinates live in), scaled to \`width\` x \`height\`. Draw holds over it
  with no homography: multiply canonical coordinates by width / boardWidth.

  Read in its own query (\`sprayWallArt\`), never in a shared fragment.
  """
  type SprayWallArt {
    versionNumber: Int!
    "The rendering recipe the server runs. Art made by another recipe reads as NONE."
    recipe: Int!
    status: SprayWallArtStatus!
    width: Int
    height: Int
    quality: SprayWallPhotoQuality!
    "Wall only: the photo flattened into the canonical frame. JPEG. Null unless READY."
    crop: SprayWallPhoto
    "Holds only: the same pixels, transparent everywhere but the holds. WebP with alpha; draw the field colour behind it. Null unless READY."
    cutout: SprayWallPhoto
  }

  """
  Everything a renderer needs for one wall at one version: the photo, the
  geometry that maps it, and the holds alive at that version.

  The stored photo is never warped — the client maps holds through the INVERSE of
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
    """
    Presigned GET for the photo at up to 5712 px on its long side, or null when
    this version has no copy larger than \`photo\` (#5911). Same pixels and frame
    as \`photo\`, just more of them: the hold editor swaps it in once it zooms past
    the base photo's resolution. Expires with \`photo.expiresAt\`.
    """
    photoFullUrl: String
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
    "Accepted and ignored. Only a climb's setter edits it."
    climbEditPolicy: SprayClimbEditPolicy @deprecated(reason: "Retired. Accepted and ignored.")
    """
    Let this wall's photo and marked holds help train hold finding. Off when
    omitted: only a client that showed the owner the switch can say yes, so
    the app sends it explicitly.
    """
    trainingConsent: Boolean
  }

  "How many climbs on a wall use one hold. See \`sprayWallHoldUsage\`."
  type SprayWallHoldUsage {
    holdId: Int!
    "Published climbs that use the hold. Removing it gives each of them a lost hold."
    publishedClimbCount: Int!
    "Draft climbs that use the hold."
    draftClimbCount: Int!
  }

  input ResetSprayWallInput {
    "The published, live wall to replace."
    wallUuid: ID!
  }

  input CreateSprayWallVersionInput {
    wallUuid: ID!
    "photoId from POST /api/spray-wall-photos. Supply exactly one of photoId and sourceVersionId."
    photoId: ID
    "Reuse this wall's current published photo and its saved geometry for hold editing. Supply exactly one of photoId and sourceVersionId."
    sourceVersionId: ID
    "The wall's four corners in an uploaded photo's pixels, TL/TR/BR/BL, as [[x, y], ...]. When sourceVersionId is supplied, omit this field entirely; explicit null is rejected."
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
    """
    What the climber did with the suggestion. AUTO holds only; ignored on MANUAL.
    The server keeps the highest of this, the stored value and EDITED when the
    geometry changed (against the stored hold, or the movedFromHoldId one), so
    an omitted value never clears one. An explicit null does clear it.
    """
    autoReview: SprayHoldAutoReview
    """
    The detection run the suggestion came from, with originCandidateIndex. AUTO
    holds only. A run of another wall, an unfinished run or an index out of range
    is stored as null rather than failing the save. Omit both to keep what the
    hold already records; send originDetectionId: null to clear it.
    """
    originDetectionId: ID
    originCandidateIndex: Int
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
    "Accepted and ignored. Only a climb's setter edits it."
    climbEditPolicy: SprayClimbEditPolicy @deprecated(reason: "Retired. Accepted and ignored.")
    """
    Let this wall's photo and marked holds help train hold finding. Owner only,
    like visibility. false switches it off for the whole physical wall: this
    wall, every wall it was reset from and every reset clone made from any of
    them. They leave the next training export, and stored exports that held one
    of them are retired within 24 hours. true switches it on for this wall only.
    """
    trainingConsent: Boolean
  }

  input SetSprayWallRenderSettingsInput {
    uuid: ID!
    """
    Required: always send the key. A { mode, boardsesh } blob sets the wall's
    stored default; an explicit null clears it. Omitting the key is rejected
    rather than read as "leave it alone" — this mutation only ever sets or clears.

    Declared nullable (not JSON!) because a non-null scalar could not carry the
    null that clears it.
    """
    renderSettings: JSON
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
  What an in-place reset would have done. Retired with \`proposeSprayWallReset\`,
  which now always refuses; kept so older apps' documents still validate.
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
  Publish a wall's FIRST version. The in-place reset this input was built for is
  retired: a draft with a new photo on a published wall is refused with
  SPRAY_WALL_RESET_RETIRED. The decision lists are still required by the shape,
  so older apps' documents validate, and are ignored.
  """
  input CommitSprayWallVersionInput {
    wallUuid: ID!
    "The DRAFT version to publish."
    versionId: ID!
    "Ignored. Retired with the in-place reset."
    kept: [SprayWallKeptDecisionInput!]!
    "Ignored. Retired with the in-place reset."
    removed: [Int!]!
    "Ignored. Retired with the in-place reset."
    added: [SprayWallAddedDecisionInput!]!
    "Ignored. Partial and full resets were retired with the in-place reset."
    fullReset: Boolean @deprecated(reason: "Retired with the in-place reset. Ignored.")
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
    "Climbs whose \`missingHoldCount\` moved as a result. 0 on a first publish."
    climbsChanged: Int!
  }

  """
  A remix starting point. Retired with \`remixClimb\`, which now always returns
  null; kept so older apps' documents still validate.
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
    Successors the reset review linked for the lost holds, in hold-id order.

    At most one per entry in \`lostHoldIds\`: a commit refuses two additions
    naming the same \`movedFromHoldId\`, and where the ordinary hold editor has
    left a second claim on one predecessor, the more recently installed hold
    wins. So this is a set of successors, not a
    ranking: there is no "best" suggestion to put first. It is NOT positionally
    aligned with \`lostHoldIds\` either, because a lost hold may have no successor
    at all; pair them by reading \`movedFromHoldId\` off the holds themselves.

    A remix wants somewhere to start, and \`moved_from_hold_id\` is the only
    record of which of today's holds replaced one of yesterday's.
    """
    suggestedHoldIds: [Int!]!
  }
`;

export const sprayWallModerationTypeDefs = /* GraphQL */ `
  """
  Why a climber reported a wall. A closed set — there is no free-text field
  anywhere in the report path.
  """
  enum SprayWallReportReason {
    "The photograph or the wall's name is not something we should be serving."
    INAPPROPRIATE
    "Not a climbing wall at all."
    NOT_A_WALL
    "Somebody's face, address or documents are in the frame."
    PERSONAL_INFO
    OTHER
  }

  """
  What the report did. \`ALREADY_REPORTED\` is the answer to a second report from
  the same climber: their first one still stands, and nothing about the queue's
  state leaks back to them.
  """
  enum SprayWallReportStatus {
    CREATED
    ALREADY_REPORTED
  }

  type SprayWallReportResult {
    status: SprayWallReportStatus!
  }

  input ReportSprayWallInput {
    wallUuid: ID!
    reason: SprayWallReportReason!
  }

  input SetSprayWallHiddenInput {
    uuid: ID!
    hidden: Boolean!
  }

  "The outcome of the admin switch, thin on purpose: a moderation tool, not a wall read."
  type SprayWallModerationResult {
    uuid: ID!
    layoutId: Int!
    hidden: Boolean!
    hiddenAt: String
  }

  "One pending report, for the admin queue."
  type SprayWallReport {
    id: ID!
    wallUuid: ID!
    wallName: String!
    "Admin-only preview, including private and hidden walls; null when unavailable."
    photo: SprayWallPhoto
    layoutId: Int!
    reason: SprayWallReportReason!
    "Whether the wall is hidden right now."
    hidden: Boolean!
    createdAt: String!
  }

  "What one purge run cleared. Photographs only — no wall row is ever deleted."
  type SprayWallPhotoPurgeResult {
    wallsPurged: Int!
    objectsDeleted: Int!
    wallsConsidered: Int!
    durationMs: Int!
  }
`;
