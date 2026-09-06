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
    "True when this option only matters on a wall that is building a kicker. A kickerless wall (or one where the buyer left the kicker off) can hide it."
    kickerOnly: Boolean!
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
  The limits every piece of artwork is held to, so a configurator can enforce
  them before a round trip rather than discovering them from a rejection.

  Advisory to a client and binding on the server: the same numbers gate
  checkout, and a client that ignores them gets a \`CNC_INVALID_CONFIG\`.
  """
  type CncArtworkRules {
    "The most artwork items one pack may carry."
    maxItems: Int!
    "Narrowest an item may be, in mm. Below this a router bit stops resolving the shape."
    minWidthMm: Float!
    "Widest an item may be, in mm. Just under the widest panel the sheet stock can produce."
    maxWidthMm: Float!
    "Longest a routed text label may be. Past this it stops fitting on a panel at a legible height."
    maxTextChars: Int!
  }

  """
  Everything on sale, plus the catalogue version it was read at. Every order
  stores that version so a regenerate months later rebuilds the pack the buyer
  paid for rather than today's defaults.
  """
  type CncCatalog {
    version: String!
    entries: [CncCatalogEntry!]!
    """
    Typeface keys a text label may be routed in, first one being the default.

    Only faces the generator actually bundles: every character is outlined
    against a real font file, and an unknown font is rejected rather than
    substituted, so the shape approved in the editor is the shape that gets cut.
    """
    artworkFonts: [String!]!
    artworkRules: CncArtworkRules!
  }

  """
  Where one piece of artwork sits, in wall millimetres.

  \`xMm\`/\`yMm\` are the centre of the item, not a corner, so a rotation is
  about the item's own middle and a resize keeps it put.
  """
  input CncPlacementInput {
    "Index of the panel the item is routed on, from the layout response. Zero or greater."
    panelIndex: Int!
    "Centre X in wall millimetres. Must be finite; the generator does the panel-bounds check itself."
    xMm: Float!
    "Centre Y in wall millimetres. Must be finite; the generator does the panel-bounds check itself."
    yMm: Float!
    "Item width in mm; height follows from the aspect ratio. 40 to 1200 — the floor is what a router bit still resolves, the ceiling is just under the widest panel the sheet stock can produce. Out of range is rejected, not clamped."
    widthMm: Float!
    "Rotation in degrees, -180 to 180, counter-clockwise. Signed rather than 0..360 so the value comes back the way the editor's rotate handle produced it. Out of range is rejected, not normalised."
    rotationDeg: Float!
  }

  """
  One piece of custom artwork. Exactly one of \`assetId\` (an uploaded SVG) or
  \`text\` (a routed label) must be set.
  """
  input CncArtworkInput {
    "An uploaded SVG asset. Mutually exclusive with \`text\`; at most 128 characters."
    assetId: ID
    "A routed label, at most 40 characters — past that it stops fitting on a panel at a legible height. Trimmed, and it may not be empty. Mutually exclusive with \`assetId\`."
    text: String
    """
    Which bundled typeface to outline \`text\` with, from \`CncCatalog.artworkFonts\`.

    Null takes the generator's own default. A face that is not bundled is
    rejected, never substituted — a substituted font would quietly change the
    shape the buyer approved. Meaningless for an \`assetId\` item, which carries
    its own geometry.
    """
    font: String
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
    "At most 4 items. Every item costs a rotated-bbox check against every hole on its panel, and four is already more than a wall has room for at the 40 mm minimum width."
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
  Everything checkout needs beyond the configuration itself: who the licence
  names, how to reach them, and their acceptance of it.

  \`acceptLicence\` must be \`true\`. The licence is the product, so there is no
  such thing as a checkout that proceeds without it.
  """
  input CreateCncCheckoutSessionInput {
    config: CncBoardConfigInput!
    tier: CncLicenceTier!
    "The name printed on every file in the pack."
    licenseeName: String!
    "Where the licence and the download link are sent. Not taken from the account."
    licenseeEmail: String!
    "The installation the licence names. Required for \`commercial_single\`, rejected for \`personal\`."
    customerSiteName: String
    acceptLicence: Boolean!
  }

  """
  An opened Stripe Checkout Session and the order it will pay for.

  The order already exists in \`pending_payment\` by the time this comes back —
  creating a session is not a payment, and nothing is queued for generation
  until the Stripe webhook confirms the charge. Send the buyer to
  \`checkoutUrl\`; they land back on the order page either way.
  """
  type CncCheckoutSession {
    orderId: ID!
    "The licence this order will carry, reserved now so the order page works before payment lands."
    licenceId: String!
    "Stripe's hosted checkout page. Expires 31 minutes after it is created."
    checkoutUrl: String!
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

  """
  A short-lived link to one pack.

  It exists because a browser navigation cannot carry an Authorization header,
  and a session token in a URL would land in history, in a referrer and in every
  proxy log. So the grant is the weakest thing that works: one order, one user,
  five minutes, no revocation — and the download route re-checks ownership and
  refund status when it is redeemed anyway. Treat it as a click target, not as a
  credential to store.
  """
  type CncDownloadGrant {
    "Fetch or navigate to this. Streams the zip as an attachment."
    url: String!
    "ISO 8601. Ask for another one after this; nothing is lost by doing so."
    expiresAt: String!
  }
`;
