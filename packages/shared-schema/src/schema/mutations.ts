export const mutationsTypeDefs = /* GraphQL */ `
  """
  Root mutation type for all write operations.
  """
  type Mutation {
    """
    Join an existing session or create it if it doesn't exist.
    Returns the session with current state.
    """
    joinSession(sessionId: ID!, boardPath: String!, username: String, avatarUrl: String, initialQueue: [ClimbQueueItemInput!], initialCurrentClimb: ClimbQueueItemInput, sessionName: String): Session!

    """
    Create a new session with GPS coordinates for discovery.
    """
    createSession(input: CreateSessionInput!): Session!

    """
    Leave the current session.
    """
    leaveSession: Boolean!

    """
    End a session (leader only).
    """
    endSession(sessionId: ID!): SessionSummary

    """
    Update display name and avatar in the current session.
    """
    updateUsername(username: String!, avatarUrl: String): Boolean!

    """
    Add a climb to the queue.
    Optional position parameter for inserting at specific index.
    """
    addQueueItem(item: ClimbQueueItemInput!, position: Int): ClimbQueueItem!

    """
    Remove a climb from the queue by its queue item UUID.
    """
    removeQueueItem(uuid: ID!): Boolean!

    """
    Move a queue item from one position to another.
    """
    reorderQueueItem(uuid: ID!, oldIndex: Int!, newIndex: Int!): Boolean!

    """
    Set the currently displayed climb.
    Optionally adds it to the queue if not already present.
    """
    setCurrentClimb(item: ClimbQueueItemInput, shouldAddToQueue: Boolean, correlationId: ID): ClimbQueueItem

    """
    Toggle mirrored display for the current climb.
    """
    mirrorCurrentClimb(mirrored: Boolean!): ClimbQueueItem

    """
    Replace a queue item with a new one (same UUID).
    """
    replaceQueueItem(uuid: ID!, item: ClimbQueueItemInput!): ClimbQueueItem!

    """
    Replace the entire queue state.
    Used for bulk operations or syncing from external sources.
    """
    setQueue(queue: [ClimbQueueItemInput!]!, currentClimbQueueItem: ClimbQueueItemInput): QueueState!

    # ============================================
    # User Management Mutations (require auth)
    # ============================================

    """
    Update current user's profile.
    Requires authentication.
    """
    updateProfile(input: UpdateProfileInput!): UserProfile!

    """
    Delete the current user's account.
    Deletes draft climbs, optionally removes setter name from published climbs,
    then deletes the user row (cascading all related data).
    Requires authentication.
    """
    deleteAccount(input: DeleteAccountInput!): Boolean!

    # ============================================
    # Aurora Credentials Mutations (require auth)
    # ============================================

    """
    Save Aurora climbing credentials.
    Validates with Aurora API before saving.
    """
    saveAuroraCredential(input: SaveAuroraCredentialInput!): AuroraCredentialStatus!

    """
    Delete stored Aurora credentials for a board type.
    """
    deleteAuroraCredential(boardType: String!): Boolean!

    # ============================================
    # Favorites Mutations (require auth)
    # ============================================

    """
    Toggle favorite status for a climb.
    Returns new favorite state.
    """
    toggleFavorite(input: ToggleFavoriteInput!): ToggleFavoriteResult!

    # ============================================
    # Ticks Mutations (require auth)
    # ============================================

    """
    Save a new tick (climb attempt record).
    """
    saveTick(input: SaveTickInput!): Tick!

    # ============================================
    # Climb Mutations (require auth)
    # ============================================

    """
    Save a new climb for an Aurora-style board.
    """
    saveClimb(input: SaveClimbInput!): SaveClimbResult!

    """
    Save a new MoonBoard climb.
    """
    saveMoonBoardClimb(input: SaveMoonBoardClimbInput!): SaveClimbResult!

    # ============================================
    # Playlist Mutations (require auth)
    # ============================================

    """
    Create a new playlist.
    """
    createPlaylist(input: CreatePlaylistInput!): Playlist!

    """
    Update playlist metadata.
    """
    updatePlaylist(input: UpdatePlaylistInput!): Playlist!

    """
    Delete a playlist (owner only).
    """
    deletePlaylist(playlistId: ID!): Boolean!

    """
    Add a climb to a playlist.
    """
    addClimbToPlaylist(input: AddClimbToPlaylistInput!): PlaylistClimb!

    """
    Remove a climb from a playlist.
    """
    removeClimbFromPlaylist(input: RemoveClimbFromPlaylistInput!): Boolean!

    """
    Update only lastAccessedAt for a playlist (does not update updatedAt).
    """
    updatePlaylistLastAccessed(playlistId: ID!): Boolean!

    # ============================================
    # ESP32 Controller Mutations
    # ============================================

    # Register a new ESP32 controller (generates API key) - requires auth
    registerController(input: RegisterControllerInput!): ControllerRegistration!
    # Delete a registered controller - requires auth
    deleteController(controllerId: ID!): Boolean!
    # ============================================
    # Social / Follow Mutations (require auth)
    # ============================================

    """
    Follow a user. Idempotent (no error if already following).
    """
    followUser(input: FollowInput!): Boolean!

    """
    Unfollow a user.
    """
    unfollowUser(input: FollowInput!): Boolean!

    """
    Follow a setter by username. Idempotent.
    """
    followSetter(input: FollowSetterInput!): Boolean!

    """
    Unfollow a setter by username.
    """
    unfollowSetter(input: FollowSetterInput!): Boolean!

    """
    Follow a playlist. Idempotent. Only public playlists can be followed.
    """
    followPlaylist(input: FollowPlaylistInput!): Boolean!

    """
    Unfollow a playlist.
    """
    unfollowPlaylist(input: FollowPlaylistInput!): Boolean!

    """
    Subscribe to new climbs for a board type and layout.
    """
    subscribeNewClimbs(input: NewClimbSubscriptionInput!): Boolean!

    """
    Unsubscribe from new climbs for a board type and layout.
    """
    unsubscribeNewClimbs(input: NewClimbSubscriptionInput!): Boolean!

    # ============================================
    # Board Entity Mutations (require auth)
    # ============================================

    """
    Create a new board.
    """
    createBoard(input: CreateBoardInput!): UserBoard!

    """
    Update a board's metadata.
    """
    updateBoard(input: UpdateBoardInput!): UserBoard!

    """
    Soft-delete a board.
    """
    deleteBoard(boardUuid: ID!): Boolean!

    """
    Follow a board.
    """
    followBoard(input: FollowBoardInput!): Boolean!

    """
    Unfollow a board.
    """
    unfollowBoard(input: FollowBoardInput!): Boolean!

    # ============================================
    # Gym Entity Mutations (require auth)
    # ============================================

    """
    Create a new gym.
    """
    createGym(input: CreateGymInput!): Gym!

    """
    Update a gym's metadata.
    """
    updateGym(input: UpdateGymInput!): Gym!

    """
    Soft-delete a gym.
    """
    deleteGym(gymUuid: ID!): Boolean!

    """
    Add a member to a gym.
    """
    addGymMember(input: AddGymMemberInput!): Boolean!

    """
    Remove a member from a gym.
    """
    removeGymMember(input: RemoveGymMemberInput!): Boolean!

    """
    Follow a gym.
    """
    followGym(input: FollowGymInput!): Boolean!

    """
    Unfollow a gym.
    """
    unfollowGym(input: FollowGymInput!): Boolean!

    """
    Link or unlink a board to/from a gym.
    """
    linkBoardToGym(input: LinkBoardToGymInput!): Boolean!

    # ============================================
    # Session Editing Mutations (require auth)
    # ============================================

    """
    Update an inferred session's name and/or description.
    Must be a participant of the session.
    """
    updateInferredSession(input: UpdateInferredSessionInput!): SessionDetail

    """
    Add a user to an inferred session by reassigning their overlapping ticks.
    Must be a participant of the session.
    """
    addUserToSession(input: AddUserToSessionInput!): SessionDetail

    """
    Remove a user from an inferred session, restoring their ticks to original sessions.
    Must be a participant of the session.
    """
    removeUserFromSession(input: RemoveUserFromSessionInput!): SessionDetail

    # ============================================
    # Notification Mutations (require auth)
    # ============================================

    """
    Mark a notification as read.
    """
    markNotificationRead(notificationUuid: ID!): Boolean!

    """
    Mark all notifications in a group as read.
    Returns the number of notifications that were marked as read.
    """
    markGroupNotificationsRead(type: NotificationType!, entityType: SocialEntityType, entityId: String): Int!

    """
    Mark all notifications as read.
    """
    markAllNotificationsRead: Boolean!

    # ============================================
    # Comments & Votes Mutations (require auth)
    # ============================================

    """
    Add a comment to an entity.
    """
    addComment(input: AddCommentInput!): Comment!

    """
    Update a comment's body text.
    """
    updateComment(input: UpdateCommentInput!): Comment!

    """
    Delete a comment (soft-delete if it has replies).
    """
    deleteComment(commentUuid: ID!): Boolean!

    """
    Vote on an entity. Same value toggles (removes vote).
    """
    vote(input: VoteInput!): VoteSummary!

    # ============================================
    # Community Proposals Mutations (require auth)
    # ============================================

    """
    Create a proposal for a climb grade/classic/benchmark change.
    """
    createProposal(input: CreateProposalInput!): Proposal!

    """
    Vote on an open proposal.
    """
    voteOnProposal(input: VoteOnProposalInput!): Proposal!

    """
    Resolve a proposal (admin/leader only).
    """
    resolveProposal(input: ResolveProposalInput!): Proposal!

    """
    Delete an accepted proposal and revert its effects (admin/leader only).
    """
    deleteProposal(input: DeleteProposalInput!): Boolean!

    """
    Setter override: directly set community status for your own climb.
    """
    setterOverrideCommunityStatus(input: SetterOverrideInput!): ClimbCommunityStatus!

    """
    Freeze or unfreeze a climb from receiving proposals (admin/leader only).
    """
    freezeClimb(input: FreezeClimbInput!): Boolean!

    """
    Set a community setting (admin/leader only).
    """
    setCommunitySettings(input: SetCommunitySettingInput!): CommunitySetting!

    """
    Grant a community role to a user (admin only).
    """
    grantRole(input: GrantRoleInput!): CommunityRoleAssignment!

    """
    Revoke a community role from a user (admin only).
    """
    revokeRole(input: RevokeRoleInput!): Boolean!

    # ESP32 sends LED positions from official app Bluetooth
    # frames: Pre-built frames string from ESP32 (preferred)
    # positions: Legacy LED positions array (for backwards compatibility)
    # Requires controller API key in connectionParams
    setClimbFromLedPositions(
      sessionId: ID!
      frames: String
      positions: [LedCommandInput!]
    ): ClimbMatchResult!
    # Navigate to previous or next climb in the queue
    # queueItemUuid: Directly navigate to this queue item (preferred)
    # direction: "next" or "previous" (fallback if queueItemUuid not provided)
    # currentClimbUuid: DEPRECATED - UUID of climb currently displayed (unreliable with duplicates)
    # Requires controller API key in connectionParams
    navigateQueue(sessionId: ID!, direction: String!, currentClimbUuid: String, queueItemUuid: String): ClimbQueueItem
    # ESP32 heartbeat to update lastSeenAt - uses API key auth via connectionParams
    controllerHeartbeat(sessionId: ID!): Boolean!
    # Authorize a controller for a specific session (requires user auth, auto-called on joinSession)
    authorizeControllerForSession(controllerId: ID!, sessionId: ID!): Boolean!
    # Send device logs to backend for forwarding to Axiom (requires controller auth)
    sendDeviceLogs(input: SendDeviceLogsInput!): SendDeviceLogsResponse!
  }
`;
