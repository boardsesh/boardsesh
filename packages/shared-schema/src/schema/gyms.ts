// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

export const gymsTypeDefs = /* GraphQL */ `
  # ============================================
  # Gym Entity Types
  # ============================================

  enum GymMemberRole {
    "Full gym admin: edit details, manage members/boards."
    admin
    "Write access: edit gym details only. No membership/board management, no delete."
    editor
    "Plain member (social membership; no edit access)."
    member
  }

  enum GymClaimMethod {
    "Verified control of an email at the gym's website domain."
    domain
    "Awaiting a Boardsesh admin's review."
    admin
  }

  enum GymClaimStatus {
    pending
    approved
    denied
    expired
  }

  "Outcome of a requestGymClaim call, so clients can show the right next step."
  enum GymClaimRequestStatus {
    "A verification email was sent to the claimant's work address."
    email_sent
    "The claim is queued for a Boardsesh admin to review, and the claimant gets emailed the outcome either way. Mailing the team is best-effort on top of that queue, not a guarantee, so don't promise the claimant a reply."
    admin_review
    "The claim was approved on the spot — the gym was an unclaimed listing and auto-approval is on. The claimant already manages the gym."
    approved
  }

  """
  One board-type + angle pair present at a gym, for the directory's board chips.
  Deliberately minimal: a card renders "Kilter 40°", nothing else. Distinct pairs
  only, so two Kilter boards both at 40° collapse into one summary.
  """
  type GymBoardSummary {
    "Board type (kilter, tension, moonboard, ...)"
    boardType: String!
    "Board angle in degrees"
    angle: Int!
  }

  """
  The viewer's own ownership claim on a gym that hasn't been resolved yet.
  Viewer-scoped: null for signed-out viewers and for anyone with no live claim.
  """
  type MyGymClaim {
    "Claim row id."
    id: ID!
    "How it gets verified: an emailed domain link, or a Boardsesh admin's review."
    method: GymClaimMethod!
    "ISO timestamp of when the claim was filed."
    createdAt: String!
  }

  """
  A physical gym location that can contain multiple boards.
  """
  type Gym {
    "Unique identifier"
    uuid: ID!
    "URL slug for this gym"
    slug: String
    "Owner user ID"
    ownerId: ID!
    "Owner display name"
    ownerDisplayName: String
    "Owner avatar URL"
    ownerAvatarUrl: String
    "Gym name"
    name: String!
    "Optional description"
    description: String
    "Opening hours as one free-text line the gym maintains itself (no structured per-day model)."
    hours: String
    "ISO timestamp of the last time someone with edit access confirmed the hours. Shown publicly so a stale schedule reads as stale."
    hoursUpdatedAt: String
    "Physical address"
    address: String
    "Website URL (used for domain-verified ownership claims)"
    website: String
    "Contact email"
    contactEmail: String
    "Contact phone"
    contactPhone: String
    "GPS latitude"
    latitude: Float
    "GPS longitude"
    longitude: Float
    "Whether publicly visible"
    isPublic: Boolean!
    "Image URL"
    imageUrl: String
    "Square gym logo (transparent brand mark) for the kiosk and embeds — distinct from imageUrl, which is the gym photo."
    logoUrl: String
    "Kiosk/embed brand primary colour as #RRGGBB (null when unset)."
    brandPrimaryColor: String
    "Kiosk/embed brand accent colour as #RRGGBB (null when unset)."
    brandAccentColor: String
    "Kiosk/embed brand background colour as #RRGGBB (null when unset)."
    brandBackgroundColor: String
    "When created"
    createdAt: String!
    "Number of linked boards"
    boardCount: Int!
    "Distinct board types at this gym (kilter, tension, ...) — for filtering and badges"
    boardTypes: [String!]!
    "Distinct board-type + angle pairs at this gym, for directory board chips. Ordered by board type then angle and capped, so a gym with a wall of boards returns a bounded list."
    boardSummaries: [GymBoardSummary!]!
    "Number of members"
    memberCount: Int!
    "Number of followers"
    followerCount: Int!
    "Number of comments"
    commentCount: Int!
    "Whether the current user follows this gym"
    isFollowedByMe: Boolean!
    "Whether the current user is a member"
    isMember: Boolean!
    "Current user's role (null if not a member/owner)"
    myRole: GymMemberRole
    "Whether the current viewer may edit this gym (owner, gym admin, gym editor, or community admin/leader for one of its board types)"
    canEdit: Boolean!
    "Whether the current viewer may grant/revoke write access to other users (owner, gym admin, or community admin/leader for one of its board types)"
    canGrantAccess: Boolean!
    "Whether the current viewer may start an ownership claim for this gym (signed-in and not already the owner/gym admin)"
    canClaim: Boolean!
    "Whether a real person owns this gym, as opposed to the system import user. Viewer-independent — unlike canClaim, which is false for every signed-out viewer."
    isClaimed: Boolean!
    """
    The viewer's own unresolved claim on this gym, so a claimant who already
    filed sees "under review" instead of the claim call-out. A lazy field
    resolver with its own query — deliberately NOT part of enrichGym, which
    already fires ~9 round trips per gym and runs per row for up to 50 rows.
    Only the web gym page selects it; GYM_FIELDS leaves it out, which is why it
    is nullable.
    """
    myPendingClaim: MyGymClaim
  }

  """
  Paginated list of gyms.
  """
  type GymConnection {
    "List of gyms"
    gyms: [Gym!]!
    "Total number of gyms"
    totalCount: Int!
    "Whether more gyms are available"
    hasMore: Boolean!
  }

  "Where a gym came from: an upstream provider sync or a Boardsesh user."
  enum GymOwnerType {
    "System-synced from an upstream board provider (Boardsesh catalog)."
    SYSTEM
    "Created by a Boardsesh user."
    USER
  }

  """
  A live gym that resembles one the user is about to create — surfaced so they
  can view or claim it instead of making a duplicate.
  """
  type SimilarGym {
    "Unique identifier"
    uuid: ID!
    "URL slug for this gym"
    slug: String
    "Gym name"
    name: String!
    "Physical address"
    address: String
    "Website URL (used for domain-verified ownership claims)"
    website: String
    "Distance in metres from the supplied coordinates; null when no coordinates were given."
    distanceMeters: Float
    "Whether this gym came from an upstream provider sync (SYSTEM) or a user (USER)."
    ownerType: GymOwnerType!
    "Whether the current viewer can start an ownership claim for this gym."
    isClaimable: Boolean!
    "Upstream provider origins for a synced gym (e.g. \\"kilter\\", \\"tension\\"), from source-key prefixes. Empty for user-created gyms."
    providerOrigins: [String!]!
  }

  """
  Why a board is a candidate to attach to a gym in strayBoardsForGym.
  """
  enum StrayBoardReason {
    "The board sits on a listing that was merged into this gym."
    MERGED_TWIN
    "The board is physically within ~150 m of this gym but isn't linked to it."
    NEARBY
  }

  """
  A board that probably belongs to a gym but isn't linked to it yet — either it
  followed a listing that got merged into this gym, or it sits at the gym's
  coordinates while unlinked or attached to a synced (SYSTEM) listing.
  """
  type StrayBoard {
    "The board's unique identifier."
    uuid: ID!
    "The board's display name."
    name: String!
    "The gym this board is currently linked to (a merged twin or a synced listing); null when unlinked."
    currentGymUuid: ID
    "Name of the gym this board is currently linked to; null when unlinked."
    currentGymName: String
    "Metres from this gym's location to the board; null when either lacks coordinates."
    distanceMeters: Float
    "Why this board is a candidate for this gym."
    reason: StrayBoardReason!
    "True when attaching this board empties the auto-synced listing it sits on, which then folds into this gym. False for an unlinked board, and for a listing that never folds (already merged, or owned by a person)."
    isLastBoardAtCurrentGym: Boolean!
  }

  """
  A member of a gym.
  """
  type GymMember {
    "User ID"
    userId: ID!
    "Display name"
    displayName: String
    "Avatar URL"
    avatarUrl: String
    "Role in the gym"
    role: GymMemberRole!
    "When the member joined"
    createdAt: String!
  }

  """
  Paginated list of gym members.
  """
  type GymMemberConnection {
    "List of members"
    members: [GymMember!]!
    "Total number of members"
    totalCount: Int!
    "Whether more members are available"
    hasMore: Boolean!
  }

  """
  Input for creating a gym.
  """
  input CreateGymInput {
    "Gym name"
    name: String!
    "Optional description"
    description: String
    "Physical address"
    address: String
    "Website URL"
    website: String
    "Contact email"
    contactEmail: String
    "Contact phone"
    contactPhone: String
    "GPS latitude"
    latitude: Float
    "GPS longitude"
    longitude: Float
    "Whether publicly visible (default true)"
    isPublic: Boolean
    "Image URL"
    imageUrl: String
    "Optional board UUID to link on creation"
    boardUuid: String
  }

  """
  Input for updating a gym.
  """
  input UpdateGymInput {
    "Gym UUID to update"
    gymUuid: ID!
    "New name"
    name: String
    "New slug"
    slug: String
    "New description"
    description: String
    "New free-text opening hours. Writing this stamps hoursUpdatedAt; pass null to clear both."
    hours: String
    "New address"
    address: String
    "New website URL"
    website: String
    "New contact email"
    contactEmail: String
    "New contact phone"
    contactPhone: String
    "New GPS latitude"
    latitude: Float
    "New GPS longitude"
    longitude: Float
    "New visibility"
    isPublic: Boolean
    "New image URL"
    imageUrl: String
    "Square gym logo (transparent brand mark) for the kiosk and embeds — distinct from imageUrl, the gym photo. Pass null to clear it."
    logoUrl: String
    "Kiosk/embed brand primary colour as #RRGGBB. Pass null to clear it."
    brandPrimaryColor: String
    "Kiosk/embed brand accent colour as #RRGGBB. Pass null to clear it."
    brandAccentColor: String
    "Kiosk/embed brand background colour as #RRGGBB. Pass null to clear it."
    brandBackgroundColor: String
  }

  """
  Input for adding a member to a gym.
  """
  input AddGymMemberInput {
    "Gym UUID"
    gymUuid: ID!
    "User ID to add"
    userId: ID!
    "Role for the new member"
    role: GymMemberRole!
  }

  """
  Input for removing a member from a gym.
  """
  input RemoveGymMemberInput {
    "Gym UUID"
    gymUuid: ID!
    "User ID to remove"
    userId: ID!
  }

  """
  Input for following/unfollowing a gym.
  """
  input FollowGymInput {
    "Gym UUID"
    gymUuid: ID!
  }

  """
  Input for listing current user's gyms.
  """
  input MyGymsInput {
    "Include gyms the user follows"
    includeFollowed: Boolean
    "Max gyms to return"
    limit: Int
    "Offset for pagination"
    offset: Int
  }

  """
  Input for searching gyms.
  """
  input SearchGymsInput {
    "Search query"
    query: String
    "Filter to gyms that have a board of one of these types (OR)"
    boardTypes: [String!]
    "Filter to gyms that have a board with one of these layout ids (OR). Combined with boardTypes/sizeIds, all must match the same board."
    layoutIds: [Int!]
    "Filter to gyms that have a board with one of these size ids (OR). Combined with boardTypes/layoutIds, all must match the same board."
    sizeIds: [Int!]
    "Only gyms with two or more distinct board types"
    multiBoardTypeOnly: Boolean
    "Only gyms that have a URL slug, i.e. that can be linked to at /gym/[slug]. Opt-in: omitting it leaves the emitted SQL untouched for existing callers."
    requireSlug: Boolean
    "Latitude for proximity search"
    latitude: Float
    "Longitude for proximity search"
    longitude: Float
    "Radius in km for proximity search (default 50)"
    radiusKm: Float
    "Max results to return"
    limit: Int
    "Offset for pagination"
    offset: Int
  }

  """
  Input for finding gyms that resemble one the user is about to create (dedup
  suggestions). Coordinates are optional — with them the match adds proximity
  tiers; without them it falls back to name-only matching.
  """
  input FindSimilarGymsInput {
    "Proposed gym name to match against existing gyms."
    name: String!
    "Optional latitude for proximity matching."
    latitude: Float
    "Optional longitude for proximity matching."
    longitude: Float
  }

  """
  Input for listing gym members.
  """
  input GymMembersInput {
    "Gym UUID"
    gymUuid: ID!
    "Max members to return"
    limit: Int
    "Offset for pagination"
    offset: Int
  }

  """
  Input for linking a board to a gym.
  """
  input LinkBoardToGymInput {
    "Board UUID"
    boardUuid: ID!
    "Gym UUID (null to unlink)"
    gymUuid: String
  }

  """
  Input for attaching a stray board (from strayBoardsForGym) to a gym. Unlike
  linkBoardToGym, the caller need not own the board — the gate is edit access to
  the target gym plus the board actually being a stray candidate for it.
  """
  input AttachBoardToGymInput {
    "Gym UUID to attach the board to"
    gymUuid: ID!
    "Stray board UUID to attach"
    boardUuid: ID!
  }

  """
  Input for removing a board from a gym's listing. The gate is edit access to the
  gym; the board must currently be listed at it. Clears the link only — the board
  itself is untouched and stays its owner's.
  """
  input DetachBoardFromGymInput {
    "Gym UUID to detach the board from"
    gymUuid: ID!
    "Board UUID to detach"
    boardUuid: ID!
  }

  """
  Input for granting a user write (editor) access to a gym.
  """
  input GrantGymWriteAccessInput {
    "Gym UUID"
    gymUuid: ID!
    "User ID to grant write access to"
    userId: ID!
  }

  """
  Input for revoking a user's write (editor) access to a gym.
  """
  input RevokeGymWriteAccessInput {
    "Gym UUID"
    gymUuid: ID!
    "User ID to revoke write access from"
    userId: ID!
  }

  """
  Input for requesting ownership of a gym.
  """
  input RequestGymClaimInput {
    "Gym UUID to claim"
    gymUuid: ID!
    "Work email at the gym's website domain (domain-verified path). Omit to request admin review."
    claimEmail: String
    "Optional note to the reviewer (admin-review path)."
    message: String
  }

  """
  Result of requesting a gym claim.
  """
  type RequestGymClaimResult {
    "Which path the claim took."
    status: GymClaimRequestStatus!
    "The address a verification email was sent to (domain path only)."
    email: String
  }

  """
  A pending or resolved gym ownership claim (admin queue).
  """
  type GymClaim {
    "Claim ID"
    id: ID!
    "The gym being claimed"
    gymUuid: ID!
    "Gym name (denormalized for the admin queue)"
    gymName: String!
    "Claimant user ID"
    claimantUserId: ID!
    "Claimant display name"
    claimantDisplayName: String
    "Claimant avatar URL"
    claimantAvatarUrl: String
    "How the claim was made"
    method: GymClaimMethod!
    "Current status"
    status: GymClaimStatus!
    "Email address (domain path)"
    claimEmail: String
    "Note to reviewer (admin path)"
    message: String
    "When the claim was created"
    createdAt: String!
  }

  """
  Paginated list of gym claims.
  """
  type GymClaimConnection {
    "List of claims"
    claims: [GymClaim!]!
    "Total number of claims"
    totalCount: Int!
    "Whether more claims are available"
    hasMore: Boolean!
  }

  """
  Decision for reviewing a gym claim.
  """
  enum GymClaimDecision {
    approve
    deny
  }

  """
  Input for an admin reviewing a pending gym claim.
  """
  input ReviewGymClaimInput {
    "Claim ID to review"
    claimId: ID!
    "Whether to approve (transfer ownership) or deny"
    decision: GymClaimDecision!
  }

  """
  Input for listing pending gym claims (admin only).
  """
  input PendingGymClaimsInput {
    "Max claims to return"
    limit: Int
    "Offset for pagination"
    offset: Int
  }

  # ============================================
  # Gym Insights (owner activity dashboard)
  # ============================================

  """
  One climb from the gym's top-10 for the current window, ranked by ascents.
  A row is keyed by (climbUuid, boardType, angle) — the same key board_climb_stats
  uses — so the same holds set at two angles shows as two rows with their own
  grades. \`name\` and \`gradeName\` are best-effort: a climb missing its catalog
  row (unsynced) or its consensus grade (MoonBoard, too few ascents) returns null
  and the UI falls back gracefully.
  """
  type GymTopClimb {
    "The climb's UUID."
    climbUuid: ID!
    "Board type (kilter, tension, moonboard, ...)."
    boardType: String!
    "The angle the ticks were logged at."
    angle: Int!
    "Climb display name (null when the catalog row is missing)."
    name: String
    "Consensus grade name, e.g. \\"V4\\" (null when no grade is resolvable)."
    gradeName: String
    "Ascents (flash + send) on this climb in the current window."
    ascentCount: Int!
  }

  """
  Ascents bucketed by day of week for the current window. \`dayOfWeek\` follows
  Postgres EXTRACT(DOW): 0 = Sunday … 6 = Saturday. Only days with at least one
  ascent appear; the UI fills the missing days with zero.

  Bucketing is by UTC day: \`climbed_at\` is a naive (no-timezone) timestamp and
  EXTRACT(DOW) reads it as-is, so a gym has no local-time correction. For a gym
  west of UTC a Friday-evening send can land in Saturday's bucket. This is the
  accepted v1 behaviour — there is no per-gym timezone yet; gym-local bucketing
  is a possible follow-up once a timezone is stored.
  """
  type GymDayActivity {
    "Day of week (UTC), 0 = Sunday … 6 = Saturday."
    dayOfWeek: Int!
    "Ascents (flash + send) on that weekday in the current window."
    ascentCount: Int!
  }

  """
  The two deltable counts for one window (current or previous). Kept separate
  from the top-climb / busiest-day lists because only these scalars feed the
  week-over-week deltas; the lists are only rendered for the current window.
  """
  type GymStatsWindow {
    "Distinct climbers with a flash/send on the gym's boards in this window."
    uniqueClimbers: Int!
    "Total ascents (flash + send) on the gym's boards in this window."
    ascentCount: Int!
  }

  """
  A gym owner's activity snapshot for the current window and the window
  immediately before it (same length), for week-over-week deltas. Every
  aggregate is bounded to the gym's linked boards and the time window — no
  unbounded tick scans. \`topClimbs\` and \`busiestDays\` cover the CURRENT window
  only (that's all the dashboard renders). Requires gym edit access.
  """
  type GymStats {
    "The gym these stats are for."
    gymUuid: ID!
    "Window length in days (7 for the default week)."
    periodDays: Int!
    "Counts for the current window (last \`periodDays\` days)."
    current: GymStatsWindow!
    "Counts for the window immediately before the current one (same length)."
    previous: GymStatsWindow!
    "Top 10 climbs by ascents in the current window."
    topClimbs: [GymTopClimb!]!
    "Ascents per day of week in the current window (only non-empty days)."
    busiestDays: [GymDayActivity!]!
  }

  """
  Input for the gym Insights query. \`period\` sets the window length: \`week\`
  (7 days, the default) or \`month\` (30 days). The comparison window is always the
  equally-long span immediately before it.
  """
  input GymStatsInput {
    "The gym to report on. The caller must have gym edit access."
    gymUuid: ID!
    "Window length: week (7 days, default) or month (30 days)."
    period: GymStatsPeriod
  }

  """
  Supported Insights window lengths.
  """
  enum GymStatsPeriod {
    "Rolling last 7 days."
    week
    "Rolling last 30 days."
    month
  }

  # ============================================
  # Gym Duplicate Review (admin only)
  # ============================================

  "Who owns a gym row in the duplicate queue: the system import user, or a real person. (Distinct from GymOwnerType, which the similar-gyms search uses with SYSTEM/USER casing.)"
  enum DuplicateGymOwnerType {
    "Owned by the system import user (a synced public listing)."
    system
    "Owned by a real Boardsesh user."
    user
  }

  "The strongest ownership-claim state on a gym row."
  enum GymClusterClaimStatus {
    "No claim on file."
    none
    "A claim is awaiting review or verification."
    pending
    "A claim was approved (ownership transferred)."
    approved
  }

  "How tightly a candidate duplicate cluster's members sit together."
  enum DuplicateClusterTier {
    "Every member within 20 m — almost certainly the same wall."
    A
    "Members within 150 m — the observed cross-provider coordinate-drift band."
    B
  }

  "One gym row inside a candidate duplicate cluster, with the signals an admin needs to pick the survivor."
  type DuplicateGymMember {
    "Gym UUID (always a live, canonical row)."
    gymUuid: ID!
    "Gym name."
    name: String!
    "Physical address (if known)."
    address: String
    "Whether the system import user or a real user owns this row."
    ownerType: DuplicateGymOwnerType!
    "Strongest ownership-claim state on this row."
    claimStatus: GymClusterClaimStatus!
    "Distinct location-sync provider origins (source_key prefixes: kilter, tension, ...)."
    providerOrigins: [String!]!
    "Linked, non-deleted boards."
    boardCount: Int!
    "Followers."
    followerCount: Int!
    "Members."
    memberCount: Int!
    "Live kiosks."
    kioskCount: Int!
    "Ownership claims on file (any status)."
    claimCount: Int!
    "When created."
    createdAt: String!
    "GPS latitude."
    latitude: Float!
    "GPS longitude."
    longitude: Float!
    "Distance in metres from this row to the cluster's suggested canonical survivor."
    distanceToCanonicalMeters: Float!
    "Whether the rule pre-selects this row as the canonical survivor (claimed/user-owned over system, then completeness/oldest)."
    isSuggestedCanonical: Boolean!
  }

  "A candidate cluster of live gym rows that look like the same physical location."
  type DuplicateGymCluster {
    "Stable identity (hash of the sorted member gym ids). Dismissals key on this."
    signature: String!
    "How tightly the members sit together."
    tier: DuplicateClusterTier!
    "The shared normalized name."
    normalizedName: String!
    "The rule's suggested canonical survivor (an admin may override)."
    suggestedCanonicalGymUuid: ID!
    "Largest pairwise distance in metres between any two members."
    maxDistanceMeters: Float!
    "The cluster's member rows."
    members: [DuplicateGymMember!]!
  }

  "Paginated list of candidate duplicate clusters."
  type DuplicateGymClusterConnection {
    "The clusters."
    clusters: [DuplicateGymCluster!]!
    "Total number of clusters (after dismissals are excluded)."
    totalCount: Int!
    "Whether more clusters are available."
    hasMore: Boolean!
  }

  "Input for listing candidate duplicate clusters (admin only)."
  input DuplicateGymClustersInput {
    "Max clusters to return."
    limit: Int
    "Offset for pagination."
    offset: Int
  }

  "An alias-less, system-owned live gym with no location-sync source — an orphan for the audit list."
  type OrphanGym {
    "Gym UUID."
    gymUuid: ID!
    "URL slug (null when unset — link via the uuid instead)."
    slug: String
    "Gym name."
    name: String!
    "Physical address (if known)."
    address: String
    "Linked, non-deleted boards."
    boardCount: Int!
    "Followers."
    followerCount: Int!
    "Members."
    memberCount: Int!
    "Live kiosks."
    kioskCount: Int!
    "When created."
    createdAt: String!
  }

  "Paginated list of orphan gyms (list-only, no actions)."
  type OrphanGymConnection {
    "The orphan gyms."
    gyms: [OrphanGym!]!
    "Total number of orphan gyms."
    totalCount: Int!
    "Whether more orphan gyms are available."
    hasMore: Boolean!
  }

  "Input for the orphan-gym audit list (admin only)."
  input OrphanGymsInput {
    "Max gyms to return."
    limit: Int
    "Offset for pagination."
    offset: Int
  }

  "Input for merging duplicate gyms into a canonical survivor (admin only)."
  input MergeGymsInput {
    "The survivor gym UUID."
    canonicalGymUuid: ID!
    "The gym UUIDs to fold into the survivor."
    duplicateGymUuids: [ID!]!
    "Explicit acknowledgement required to keep a SYSTEM listing as the survivor over a user-owned or claim-approved duplicate. Rejected without it."
    allowSystemCanonicalOverride: Boolean
  }

  "A kiosk whose slug had to change during a merge — its printed install QR must be reprinted."
  type KioskSlugWarning {
    "Kiosk UUID."
    kioskUuid: ID!
    "Kiosk name."
    kioskName: String!
    "Slug before the merge."
    previousSlug: String!
    "Slug after the merge (suffixed to avoid a collision on the canonical gym)."
    newSlug: String!
  }

  "What one duplicate merge re-pointed onto the canonical gym."
  type GymMergeCounts {
    "Boards moved."
    boards: Int!
    "Follows moved (deduped)."
    follows: Int!
    "Members moved (deduped)."
    members: Int!
    "Claims moved onto the canonical."
    claims: Int!
    "Kiosks moved."
    kiosks: Int!
    "Comments moved."
    comments: Int!
  }

  "The result of folding one duplicate into the canonical."
  type GymMergeDuplicateResult {
    "The duplicate that was merged."
    duplicateGymUuid: ID!
    "What moved."
    counts: GymMergeCounts!
    "Kiosk slug changes the admin must surface."
    warnings: [KioskSlugWarning!]!
  }

  "The result of a mergeGyms call — one entry per merged duplicate."
  type MergeGymsResult {
    "The survivor gym UUID."
    canonicalGymUuid: ID!
    "Per-duplicate outcomes."
    results: [GymMergeDuplicateResult!]!
  }

  "Input for dismissing a candidate cluster (marks it not-a-duplicate; hides it from the queue)."
  input DismissGymClusterInput {
    "All member gym UUIDs of the cluster (order-independent; used to compute the signature)."
    gymUuids: [ID!]!
    "The suggested canonical member, recorded on the dismissal audit row."
    canonicalGymUuid: ID!
  }

  "Input for an owner-facing duplicate report: the gym being viewed and the listing the reporter believes is the same gym."
  input ReportGymDuplicateInput {
    "The gym the report is filed from (usually the one the reporter is viewing)."
    gymUuid: ID!
    "The other listing the reporter believes is the same gym."
    duplicateGymUuid: ID!
    "Optional free-text context for the admin who reviews the pair."
    note: String
  }

  "Outcome of a reportGymDuplicate call."
  type ReportGymDuplicateResult {
    "\`reported\` when the pair was surfaced to admins; \`already_reported\` when the same pair was flagged recently and no duplicate signal was sent."
    status: ReportGymDuplicateStatus!
  }

  enum ReportGymDuplicateStatus {
    reported
    already_reported
  }
`;
