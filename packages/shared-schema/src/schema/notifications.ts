export const notificationsTypeDefs = /* GraphQL */ `
  # ============================================
  # Notification Types
  # ============================================

  enum NotificationType {
    new_follower
    comment_reply
    comment_on_tick
    comment_on_climb
    vote_on_tick
    vote_on_comment
    new_climb
    new_climb_global
    proposal_approved
    proposal_rejected
    proposal_vote
    proposal_created
    new_climbs_synced
    gym_claim_approved
    proposal_on_your_climb
  }

  """
  A notification for a user about social activity.
  """
  type Notification {
    "Public unique identifier"
    uuid: ID!
    "Type of notification"
    type: NotificationType!
    "User ID of the actor who caused the notification"
    actorId: String
    "Display name of the actor"
    actorDisplayName: String
    "Avatar URL of the actor"
    actorAvatarUrl: String
    "Entity type this notification relates to"
    entityType: SocialEntityType
    "Entity ID this notification relates to"
    entityId: String
    "Preview of comment body (for comment notifications)"
    commentBody: String
    "Name of the climb (for climb-related notifications)"
    climbName: String
    "UUID of the climb (for navigation)"
    climbUuid: String
    "Board type (for navigation)"
    boardType: String
    "Proposal UUID (for proposal notifications, to deep-link to the specific proposal)"
    proposalUuid: String
    "Type of the proposal this notification is about (grade, classic, benchmark, hide)"
    proposalType: ProposalType
    "Gym name (for gym_claim_approved notifications)"
    gymName: String
    "Whether the notification has been read"
    isRead: Boolean!
    "When the notification was created (ISO 8601)"
    createdAt: String!
  }

  """
  Paginated list of notifications with counts.
  """
  type NotificationConnection {
    "List of notifications"
    notifications: [Notification!]!
    "Total number of notifications"
    totalCount: Int!
    "Number of unread notifications"
    unreadCount: Int!
    "Whether more notifications are available"
    hasMore: Boolean!
  }

  """
  An actor in a grouped notification.
  """
  type GroupedNotificationActor {
    "User ID"
    id: ID!
    "Display name"
    displayName: String
    "Avatar URL"
    avatarUrl: String
  }

  """
  A grouped notification combining multiple notifications of the same type on the same entity.
  """
  type GroupedNotification {
    "UUID of the most recent notification in the group"
    uuid: ID!
    "Type of notification"
    type: NotificationType!
    "Entity type"
    entityType: SocialEntityType
    "Entity ID"
    entityId: String
    "Number of distinct actors"
    actorCount: Int!
    "First few actors (up to 3)"
    actors: [GroupedNotificationActor!]!
    "Preview of comment body"
    commentBody: String
    "Climb name"
    climbName: String
    "Climb UUID"
    climbUuid: String
    "Board type"
    boardType: String
    """
    Layout the climb was set on. Clients need this to build a board URL that
    actually resolves: the climb query filters on layoutId, so guessing the
    board's first layout misses every Kilter Homewall / Tension Board 2 climb.
    """
    climbLayoutId: Int
    """
    Angle the climb was set at, when the setter fixed one. Null for the many
    climbs that carry no angle; clients fall back to the reader's own board.
    """
    climbAngle: Int
    """
    The climb's hold frames, so a row can draw the board art without a second
    round trip. Present wherever climbUuid is.
    """
    climbFrames: String
    """
    Sizes the climb fits. Boards whose sizes number holds independently (Woods)
    render a COMPLETELY different climb on the layout's default size, so a client
    drawing the art needs this to pick the right one.
    """
    climbCompatibleSizeIds: [Int!]
    """
    The comment thread this notification belongs to, when it has one. For a
    comment or a vote on a comment that is the commented-on entity (a tick, a
    session, a playlist climb) rather than the comment itself, so a client can
    open the thread directly.
    """
    threadEntityType: SocialEntityType
    "ID of the entity named by threadEntityType."
    threadEntityId: String
    "Proposal UUID (for deep-linking to a specific proposal)"
    proposalUuid: String
    "Type of the proposal this notification is about (grade, classic, benchmark, hide)"
    proposalType: ProposalType
    "Setter username (for new_climbs_synced notifications)"
    setterUsername: String
    "Gym name (for gym_claim_approved notifications)"
    gymName: String
    "Whether all notifications in the group are read"
    isRead: Boolean!
    "When the most recent notification was created"
    createdAt: String!
  }

  """
  Paginated grouped notification list.
  """
  type GroupedNotificationConnection {
    "List of grouped notifications"
    groups: [GroupedNotification!]!
    "Total number of groups"
    totalCount: Int!
    "Number of unread notifications"
    unreadCount: Int!
    "Whether more groups are available"
    hasMore: Boolean!
  }

  """
  Input for listing the distinct actors behind one notification group — the
  people in "Sarah and 4 others started following you". The triple is the same
  one groupedNotifications groups by, so a client passes back the fields off the
  row it tapped.
  """
  input NotificationActorsInput {
    "Notification type of the group"
    type: NotificationType!
    "Entity type of the group (null for types that carry none, like new_follower)"
    entityType: SocialEntityType
    "Entity ID of the group"
    entityId: String
    "Maximum number of actors to return"
    limit: Int
    "Number of actors to skip"
    offset: Int
  }

  """
  Subscription payload for real-time notification delivery.
  """
  type NotificationEvent {
    "The notification that was received"
    notification: Notification!
  }

  """
  Event when a new comment is added.
  """
  type CommentAdded {
    "The comment that was added"
    comment: Comment!
  }

  """
  Event when a comment is updated.
  """
  type CommentUpdated {
    "The comment that was updated"
    comment: Comment!
  }

  """
  Event when a comment is deleted.
  """
  type CommentDeleted {
    "UUID of the deleted comment"
    commentUuid: ID!
    "Entity type the comment belonged to"
    entityType: SocialEntityType!
    "Entity ID the comment belonged to"
    entityId: String!
  }

  """
  Union of possible comment update events.
  """
  union CommentEvent = CommentAdded | CommentUpdated | CommentDeleted
`;
