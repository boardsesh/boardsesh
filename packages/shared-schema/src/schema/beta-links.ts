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
`;
