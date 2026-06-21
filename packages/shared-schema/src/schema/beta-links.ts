export const betaLinksTypeDefs = /* GraphQL */ `
  """
  An external Instagram or TikTok beta link attached to a climb.
  Thumbnail (when present) is served from our own S3 bucket.
  """
  type BetaLink {
    climbUuid: String!
    link: String!
    foreignUsername: String
    angle: Int
    thumbnail: String
    isListed: Boolean
    createdAt: String
    tickUuid: ID
    boardId: Int
  }

  """
  A recent beta link enriched with the parent climb's display name. Used
  by the home-page slider where multiple climbs are aggregated together.
  """
  type RecentBetaLink {
    betaLink: BetaLink!
    climbName: String
    boardType: String!
    layoutId: Int
  }

  """
  Live, unsaved metadata for a shared Instagram/TikTok URL — used by the mobile
  share flow to preview the post and auto-match the climb from the caption
  before anything is attached. Best-effort: any field can be null if the post is
  private/unavailable or the platform doesn't expose it (caption is currently
  Instagram-only). Never throws — the user can still attach manually.
  """
  type BetaLinkPreview {
    link: String!
    thumbnail: String
    username: String
    caption: String
  }

  "A single scraped Instagram post fed to the beta-import scanner."
  input InstagramScanPostInput {
    shortcode: String!
    caption: String
    takenAt: String
  }

  "Input for instagramBetaScan: a default board plus the scraped posts."
  input InstagramBetaScanInput {
    boardType: String!
    posts: [InstagramScanPostInput!]!
  }

  "A scanned post resolved to exactly one climb (ready to attach)."
  type InstagramBetaMatch {
    shortcode: String!
    link: String!
    climbUuid: String!
    climbName: String!
    boardType: String!
    angle: Int
  }

  "A candidate climb when a scanned name matched more than one climb."
  type InstagramBetaCandidate {
    climbUuid: String!
    name: String!
    layoutId: Int!
    setterUsername: String
  }

  "A scanned post whose climb name matched multiple climbs — the user picks one."
  type InstagramBetaAmbiguous {
    shortcode: String!
    link: String!
    parsedName: String!
    boardType: String!
    angle: Int
    candidates: [InstagramBetaCandidate!]!
  }

  "A scanned post we could not act on (no caption, unparseable, or no matching climb)."
  type InstagramBetaUnmatched {
    shortcode: String!
    link: String!
    parsedName: String
    reason: String!
  }

  "Result of scanning Instagram posts against Boardsesh's catalog and existing beta."
  type InstagramBetaScanResult {
    scanned: Int!
    parsed: Int!
    missing: [InstagramBetaMatch!]!
    alreadyLinked: [InstagramBetaMatch!]!
    ambiguous: [InstagramBetaAmbiguous!]!
    unmatched: [InstagramBetaUnmatched!]!
  }
`;
