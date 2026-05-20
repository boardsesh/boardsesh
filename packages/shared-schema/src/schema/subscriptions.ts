export const subscriptionsTypeDefs = /* GraphQL */ `
  """
  Root subscription type for real-time updates.
  """
  type Subscription {
    """
    Subscribe to real-time session events (membership, lifecycle, and live stats).
    """
    sessionUpdates(sessionId: ID!): SessionEvent!

    """
    Subscribe to queue changes (items added/removed/reordered, current climb changes).
    """
    queueUpdates(sessionId: ID!): QueueEvent!
    """
    Subscribe to real-time notifications for the current user.
    Requires authentication.
    """
    notificationReceived: NotificationEvent!

    """
    Subscribe to real-time comment updates on an entity.
    """
    commentUpdates(entityType: SocialEntityType!, entityId: String!): CommentEvent!

    """
    Subscribe to new climbs for a board type and layout.
    """
    newClimbCreated(boardType: String!, layoutId: Int!): NewClimbCreatedEvent!

    """
    Subscribe to live climb stat updates for every climb on a given board
    layout. Fires after the debounced recompute finishes (~2s after a tick),
    so clients can replace optimistically-bumped values with the canonical
    numbers. Authenticated users only — anonymous clients receive an error.

    Each event carries the (climbUuid, angle) it applies to so the client
    can route updates into its local cache without a separate fetch.
    """
    climbStatsUpdated(boardType: String!, layoutId: Int!): ClimbStatsEvent!

    # ESP32 subscribes to receive LED commands - uses API key auth via connectionParams
    controllerEvents(sessionId: ID!): ControllerEvent!
  }
`;
