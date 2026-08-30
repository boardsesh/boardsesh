export const holdOutlineOverridesTypeDefs = /* GraphQL */ `
  """
  What a stored ring traces.

  SILHOUETTE is the hold's outer boundary — the shape the tracer produces and the
  renderer lights.

  LED_INNER is the INNER boundary of the same hold's LED base plate: the lit ring
  region is the silhouette MINUS that polygon. A LED_INNER ring therefore stores
  no part of the outer edge, and is only meaningful alongside the silhouette it
  sits inside.
  """
  enum HoldOutlineKind {
    SILHOUETTE
    LED_INNER
  }

  "One placement's traced hold silhouette, as a flat implicitly-closed ring."
  type PlacementOutline {
    placementId: Int!
    "Flat [x0, y0, x1, y1, ...] in units of the placement radius, relative to its centre."
    outline: [Float!]!
  }

  "A hand-drawn hold outline, replacing or annotating what the tracer produced for one placement."
  type HoldOutlineOverride {
    boardName: String!
    layoutId: Int!
    sizeId: Int!
    placementId: Int!
    "Which boundary of the hold this ring traces."
    kind: HoldOutlineKind!
    "Flat [x0, y0, x1, y1, ...] in units of the placement radius, rounded to 4 decimals."
    outline: [Float!]!
    "Why the traced version was wrong, in the editor's own words."
    note: String
    authorId: ID
    "Display name of the account that last wrote this override, when it still exists."
    authorDisplayName: String
    "When the override was last written (ISO 8601)."
    updatedAt: String!
  }

  """
  Everything the outline editor needs for one board config: the deployed shard's
  traced silhouettes, plus the live overrides that supersede or annotate them.

  The two lists are returned side by side rather than merged so the editor can
  show what the tracer produced next to what a human corrected, and offer a
  revert. A placement absent from both carries no art of its own — the renderer
  falls back to a ring at the placement radius.
  """
  type BoardHoldOutlines {
    boardName: String!
    layoutId: Int!
    sizeId: Int!
    "Traced silhouettes from the geometry shard this backend ships. Empty when no shard covers the config."
    shardOutlines: [PlacementOutline!]!
    "Live overrides of every kind, newest write per placement and kind."
    overrides: [HoldOutlineOverride!]!
  }

  """
  A board config, identified the way a geometry shard is. Set ids are absent on
  purpose: every shard is traced with every set of its layout and size mounted,
  so an override never names one.
  """
  input HoldOutlineConfigInput {
    boardName: String!
    layoutId: Int!
    sizeId: Int!
  }

  input UpsertHoldOutlineOverrideInput {
    boardName: String!
    layoutId: Int!
    sizeId: Int!
    placementId: Int!
    "Which boundary this ring traces. Defaults to SILHOUETTE."
    kind: HoldOutlineKind
    "Flat [x0, y0, x1, y1, ...] in radius units. 3-150 points, every coordinate within 4 radii, and the ring has to cover the placement centre."
    outline: [Float!]!
    note: String
  }

  input DeleteHoldOutlineOverrideInput {
    boardName: String!
    layoutId: Int!
    sizeId: Int!
    placementId: Int!
    "Which boundary to drop. Defaults to SILHOUETTE — dropping one kind leaves the other standing."
    kind: HoldOutlineKind
  }
`;
