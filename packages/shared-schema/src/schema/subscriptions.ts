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
    Subscribe to canonical climb-stat rows for a board layout. Authenticated
    users only. Each event is a complete replacement row and carries a decimal
    bigint revision for stale-event rejection.
    """
    climbStatsUpdated(boardType: String!, layoutId: Int!): ClimbStatsEvent!

    """
    Subscribe to the live "now on the wall" feed for a shared board (board_id
    resolved from the BLE serial). Membership-free; the board's policy decides.
    The board id alone is the no-link reading (ids can be counted); pass
    \`boardUuid\` to open an Unlisted board. Sessions are not involved.
    """
    boardNowPlaying(
      boardId: Int!
      "The board's uuid, its link. The numeric id alone is countable, so without this an Unlisted board reads as NOT_FOUND."
      boardUuid: ID
    ): BoardPresenceEvent!

    """
    Live redacted "Up next" previews of the party-session queue bound to a
    shared board, for anonymous public displays (gym kiosks). Each event is a
    full snapshot (latest wins — no deltas). Auth-optional with the same
    anonymous existence-hiding as \`boardNowPlaying\`; events are only ever
    published while the double privacy gate holds (anon-readable board AND
    \`isPublic: true\` bound session — see the \`boardQueuePreview\` query,
    including the deliberate widening of \`is_public\`'s meaning). The stream
    is seeded with the current snapshot when one exists, since pub/sub has no
    replay; a snapshot is also published the moment a session first binds to
    the board (its first wall report), so an always-on display doesn't stay
    blank until the next queue mutation. Items are redacted to climb-catalog
    fields only. When the bound
    session stops being previewable (ends, or goes private) an EMPTY snapshot
    (\`current: null, upNext: [], queueLength: 0\`) is published so displays
    clear instead of showing the last queue forever.
    """
    boardQueuePreview(
      boardId: Int!
      "The board's uuid, its link. The numeric id alone is countable, so without this an Unlisted board reads as NOT_FOUND."
      boardUuid: ID
    ): BoardQueuePreview!

    # ESP32 subscribes to receive LED commands - uses API key auth via connectionParams
    controllerEvents(sessionId: ID!): ControllerEvent!
  }
`;
