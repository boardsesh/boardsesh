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
