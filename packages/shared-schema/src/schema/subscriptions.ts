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

    # ESP32 subscribes to receive LED commands - uses API key auth via connectionParams
    controllerEvents(sessionId: ID!): ControllerEvent!

    """
    Subscribe to board history events for a physical board (keyed by BLE
    serial). On subscribe, the server yields a BoardHistoryFullSync followed
    by BoardHistoryEntryAdded for each new send. Soft-gated on the caller
    having a userBoardSerials row for the serial.
    """
    boardHistoryEvents(boardSerial: String!): BoardHistoryEvent!
  }
`;
