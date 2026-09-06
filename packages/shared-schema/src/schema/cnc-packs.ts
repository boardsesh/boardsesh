export const cncPacksTypeDefs = /* GraphQL */ `
  # ============================================
  # CNC build packs
  # ============================================

  """
  What the buyer is allowed to build with a pack.
  \`personal\` is one wall for their own non-commercial use; \`commercial_single\`
  is one identified customer installation, which is why those orders also carry
  a site name.
  """
  enum CncLicenceTier {
    personal
    commercial_single
  }

  """
  Lifecycle of one order. Everything after \`pending_payment\` is driven by a
  Stripe webhook or by the pack generator. \`refunded\` is terminal for
  downloads and is deliberately distinct from \`cancelled\`, which only ever
  means the checkout session expired before payment.
  """
  enum CncOrderStatus {
    pending_payment
    queued
    generating
    ready
    failed
    cancelled
    refunded
  }

  """
  How a piece of custom artwork is cut. \`engrave\` scores the surface,
  \`pocket\` clears it to a depth, \`cut_through\` goes all the way and is held
  to a wider keep-out because it weakens the panel.
  """
  enum CncArtworkMode {
    engrave
    pocket
    cut_through
  }

  "One purchasable licence tier and its price, in the smallest currency unit."
  type CncTierPrice {
    tier: CncLicenceTier!
    "Price in cents. Prices live in Stripe; this is the display copy of them."
    amountCents: Int!
    "ISO 4217 code. AUD for every v1 tier."
    currency: String!
  }

  """
  One manufacturing choice the buyer may make, with its complete allowed set.

  Values are carried as strings with a \`valueType\` tag rather than as a JSON
  blob: the catalogue mixes strings ("2440x1220"), numbers (12.5) and booleans
  in one list, and a typed field is what lets a client build the select and
  round-trip the answer without guessing. Coerce with \`valueType\` before
  comparing — the backend matches submitted values by their string form and
  stores the catalogue's own typed value.
  """
  type CncManufacturingOption {
    "Camel-case option key, e.g. \`sheetStock\` or \`tnutHoleDiameterMm\`."
    key: String!
    "The complete allowed set. Anything outside it is rejected, not clamped."
    values: [String!]!
    "The value applied when the buyer does not choose. Always a member of \`values\`."
    defaultValue: String!
    "How to read \`values\` and \`defaultValue\`: string, number or boolean."
    valueType: String!
  }

  """
  One sellable board tuple. A board/size that is not listed here cannot be
  configured, priced or generated.

  The LED-kit size aliases that resolve onto \`sizeId\` are deliberately not
  exposed: a client picks the canonical size, and alias resolution happens
  server-side so the catalogue never has to explain Aurora's kit numbering.
  """
  type CncCatalogEntry {
    boardName: String!
    layoutId: Int!
    "The canonical size id. Aliases resolve to this one before anything runs."
    sizeId: Int!
    "Comma-joined set ids, same shape as the \`[set_ids]\` URL segment."
    setIds: String!
    "Human label for the wall, e.g. \\"10x12\\"."
    label: String!
    "True when this size has kicker sets the buyer can include or leave off."
    kickerOptional: Boolean!
    manufacturingOptions: [CncManufacturingOption!]!
    tiers: [CncTierPrice!]!
  }

  """
  Everything on sale, plus the catalogue version it was read at. Every order
  stores that version so a regenerate months later rebuilds the pack the buyer
  paid for rather than today's defaults.
  """
  type CncCatalog {
    version: String!
    entries: [CncCatalogEntry!]!
  }

  """
  Where one piece of artwork sits, in wall millimetres.

  \`xMm\`/\`yMm\` are the centre of the item, not a corner, so a rotation is
  about the item's own middle and a resize keeps it put.
  """
  input CncPlacementInput {
    "Index of the panel the item is routed on, from the layout response."
    panelIndex: Int!
    xMm: Float!
    yMm: Float!
    "Item width in mm; height follows from the aspect ratio."
    widthMm: Float!
    "Rotation in degrees, -180 to 180, counter-clockwise."
    rotationDeg: Float!
  }

  """
  One piece of custom artwork. Exactly one of \`assetId\` (an uploaded SVG) or
  \`text\` (a routed label) must be set.
  """
  input CncArtworkInput {
    assetId: ID
    text: String
    mode: CncArtworkMode!
    placement: CncPlacementInput!
  }

  """
  A board tuple plus the manufacturing choices made against it. The same input
  drives the layout preview, artwork validation and checkout, so a preview can
  never disagree with what is bought.
  """
  input CncBoardConfigInput {
    boardName: String!
    layoutId: Int!
    sizeId: Int!
    "Comma-joined set ids, same shape as the \`[set_ids]\` URL segment."
    setIds: String!
    "Manufacturing options keyed by \`CncManufacturingOption.key\`. Missing keys take their default."
    options: JSON!
    artwork: [CncArtworkInput!]
  }

  """
  One order as its buyer may see it.

  The fingerprint manifest, the worker's claim token and the raw generator
  error never appear here — a failed order reports a fixed public message
  instead.
  """
  type CncOrder {
    id: ID!
    "The licence printed on every file in the pack. The id support and leak investigations start from."
    licenceId: String!
    tier: CncLicenceTier!
    status: CncOrderStatus!
    boardName: String!
    layoutId: Int!
    sizeId: Int!
    setIds: String!
    "The normalised manufacturing options this pack was priced and built with."
    options: JSON!
    "Artwork placements carried through to the generator. Empty list when there is none."
    artwork: JSON!
    licenseeName: String
    "Set only for commercial_single orders: the installation the licence names."
    customerSiteName: String
    amountCents: Int
    currency: String
    createdAt: String!
    paidAt: String
    generatedAt: String
    zipSizeBytes: Int
    downloadCount: Int!
    lastDownloadedAt: String
    "A fixed public message when the order failed, null otherwise. Never generator internals."
    errorMessage: String
  }

  """
  Verdict on a configuration's artwork, from the generator itself rather than
  the browser's live-feedback maths. \`collisions\` carries one entry per
  offending item with the panel and the reason.
  """
  type CncArtworkValidation {
    ok: Boolean!
    collisions: JSON!
  }
`;
