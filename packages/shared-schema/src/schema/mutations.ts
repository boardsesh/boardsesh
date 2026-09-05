export const mutationsTypeDefs = /* GraphQL */ `
  """
  Root mutation type for all write operations.
  """
  type Mutation {
    """
    Join an existing session or create it if it doesn't exist.
    Returns the session with current state.
    """
    joinSession(
      sessionId: ID!
      boardPath: String!
      username: String
      avatarUrl: String
      participantId: ID
      initialQueue: [ClimbQueueItemInput!]
      initialCurrentClimb: ClimbQueueItemInput
      sessionName: String
    ): Session!

    """
    Create a new session with GPS coordinates for discovery.
    """
    createSession(input: CreateSessionInput!): Session!

    """
    Leave the current session.
    """
    leaveSession: Boolean!

    """
    End a session (active participant only). The optional \`notes\` is a
    free-text end-of-session recap persisted on the session and echoed back on
    the returned SessionSummary.
    """
    endSession(sessionId: ID!, timezone: String, notes: String): SessionSummary

    """
    Update a session's title and/or recap notes. Creator only. Works on both
    active and ended sessions. Publishes SessionNameChanged to live
    participants when the title changes.
    """
    updateSession(input: UpdateSessionInput!): UpdateSessionResult!

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
    Broadcast the current playback state for a variable-speed climb so
    other party members converge to the same frame/playing/speed. The
    server stamps \`anchorTimestamp\` so peers can extrapolate elapsed
    frames since the broadcast. Echo-suppressed by \`clientId\`.
    """
    publishPlaybackState(input: PlaybackStateInput!): Boolean!

    """
    Replace a queue item with a new one (same UUID).
    """
    replaceQueueItem(uuid: ID!, item: ClimbQueueItemInput!): ClimbQueueItem!

    """
    Replace the entire queue state.
    Used for bulk operations or syncing from external sources.

    \`baselineSequence\` is the last server sequence this client had APPLIED when it
    composed \`queue\`. When supplied, the server replays its queue-event buffer from
    that point and re-appends any climb a peer added inside the window instead of
    silently overwriting it (issue #3933). Omit it for the historical wholesale
    overwrite — old clients send nothing here.
    """
    setQueue(
      queue: [ClimbQueueItemInput!]!
      currentClimbQueueItem: ClimbQueueItemInput
      baselineSequence: Int
    ): QueueState!

    """
    Confirm to all session participants that a climb was successfully relayed to the wall
    over BLE from this client's phone. Any session participant may call — the BLE-capable
    phone that handled the send is the source of truth for confirmation. The server stamps
    \`confirmedAt\` and \`confirmedByParticipantId\` from the caller's identity; clients
    cannot forge either field. Publishes \`WallConfirmedClimb\`. The optional
    \`queueItemUuid\` disambiguates the press when the same climb is queued twice. Returns
    the resolved Session so optimistic-UI callers can apply server-derived state without a
    follow-up query. Session identity is resolved from the WebSocket connection context —
    no \`sessionId\` argument is required.
    """
    confirmClimbOnWall(climbUuid: ID!, queueItemUuid: ID): Session!

    """
    Report that this client's BLE link to the wall dropped (explicit lightbulb-off or a
    detected drop), so every session participant turns the queue-control-bar lightbulb off.
    The current climb is unchanged — pressing the lightbulb re-asserts (re-sends) it.
    Publishes \`WallDisconnected\`. The session-scoped counterpart to board-presence's
    \`reportBoardDisconnect\`. Session identity is resolved from the WebSocket connection
    context — no \`sessionId\` argument is required.
    """
    reportWallDisconnect: Session!

    """
    Record the BLE board serial that this client paired with so other (mobile)
    participants can auto-connect to the same physical board. Any session participant
    may call. Idempotent: when the stored serial already matches, no event fires.
    Publishes \`SessionBoardSerialChanged\` on change. Returns the resolved Session so
    optimistic-UI callers can apply server-derived state without a follow-up query.
    Session identity is resolved from the WebSocket connection context — no
    \`sessionId\` argument is required.
    """
    setSessionBoardSerial(serial: String!): Session!

    """
    Update the session's stored boardPath so every participant follows the same
    angle (and any future presentational route-segment changes). Today the
    angle is the only route-level dimension that members observe as a group;
    climb URLs are managed by setCurrentClimb. Any participant may call —
    angle is presentational and doesn't drive BLE (hold positions are sent
    per-climb). Idempotent: when the stored boardPath already matches, no event
    fires. Publishes \`SessionBoardPathChanged\` on change. Returns the resolved
    Session so optimistic-UI callers can apply server-derived state without a
    follow-up query. Session identity is resolved from the WebSocket connection
    context — no \`sessionId\` argument is required.
    """
    setSessionBoardPath(boardPath: String!): Session!

    # ============================================
    # Board Presence Mutations ("now on the wall")
    # ============================================

    """
    Legacy serial resolver, kept for already-shipped clients that can't render
    a disambiguation prompt: always returns a single board. Serials are no
    longer globally unique, so when several boards share one this auto-picks
    (the caller's own board if present, else the oldest) and remembers it.
    New clients should call \`resolveBoardCandidatesForSerial\`. The board config
    args are used only to create the board the first time a serial is seen.

    \`advertisedBoardType\` is the board type in the controller's BLE device
    name (\`Tension Board#12345@3\`). Aurora runs a separate serial sequence per
    board app, so the same serial exists on controllers of different types; pass
    it and only boards of that type are candidates. Optional — clients shipped
    before this existed keep the old type-blind resolution.
    """
    resolveBoardForSerial(
      serial: String!
      boardType: String!
      layoutId: Int!
      sizeId: Int!
      setIds: String!
      advertisedBoardType: String
    ): ResolvedBoard!

    """
    Resolve a BLE serial for clients that can disambiguate. Returns a single
    \`board\` when the serial is unambiguous (remembered choice, only one match,
    or freshly created), or a list of \`candidates\` when several boards share
    the serial and the user must pick which wall they're at. Confirm the pick
    with \`chooseBoardForSerial\`. The config args create the board the first
    time a serial is seen.

    \`advertisedBoardType\` is the board type in the controller's BLE device
    name (\`Tension Board#12345@3\`). Aurora runs a separate serial sequence per
    board app, so the same serial exists on controllers of different types; pass
    it and only boards of that type are candidates. Optional — clients shipped
    before this existed keep the old type-blind resolution.
    """
    resolveBoardCandidatesForSerial(
      serial: String!
      boardType: String!
      layoutId: Int!
      sizeId: Int!
      setIds: String!
      advertisedBoardType: String
    ): ResolveBoardResult!

    """
    Confirm which board a (non-unique) serial routes to after the user picks
    from a disambiguation prompt. Remembers the choice per user so the prompt
    doesn't reappear, and returns the bound board. The board must be active and
    actually carry the serial.
    """
    chooseBoardForSerial(boardId: Int!, serial: String!): ResolvedBoard!

    """
    Resolve the wall feed for the selected named board. This binds to the actual
    board entity, so board sheet stats/history are available before Bluetooth
    connects and stay aligned with board-scoped ticks.
    """
    resolveBoardForUuid(boardUuid: ID!): ResolvedBoard!

    """
    Resolve the shared board feed for boards without a BLE serial. This is a
    per-config fallback in v1: every caller with the same board type, layout,
    size, and set IDs gets the same shared board id.
    """
    resolveBoardForConfig(boardType: String!, layoutId: Int!, sizeId: Int!, setIds: String!): ResolvedBoard!

    """
    Report the climb a connected phone just lit on the wall to the board's live
    "now on the wall" feed. Auth-optional — anyone connected to the board emits
    (logged-in or anonymous); a logged-in sender's identity is derived
    server-side (never client-supplied), an anonymous sender carries no name or
    avatar. Also makes the caller the board's current connection holder (the
    "who's connected" indicator). Fire-and-forget after the BLE write succeeded —
    no confirm/timeout handshake. \`angle\` is the wall angle (null = unspecified).
    """
    reportBoardClimb(boardId: Int!, climb: ClimbQueueItemInput!, angle: Int): Boolean!

    """
    Report that this client disconnected its BLE link to \`boardId\` (the explicit
    lightbulb-off, or a detected drop). Clears the board's connection holder when
    this caller held it, so the "who's connected" indicator goes free. No-op when
    someone else now holds it. Auth-optional. Returns whether the slot was freed.
    """
    reportBoardDisconnect(boardId: Int!): Boolean!

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

    """
    Add a climb to favorites. Idempotent (ON CONFLICT DO NOTHING) so the offline
    mutation queue can safely retry. Always returns true.
    """
    addFavorite(input: AddFavoriteInput!): Boolean!

    """
    Remove a climb from favorites. Idempotent (deleting a nonexistent row is a
    no-op) so the offline mutation queue can safely retry. Always returns true.
    """
    removeFavorite(input: RemoveFavoriteInput!): Boolean!

    # ============================================
    # Ticks Mutations (require auth)
    # ============================================

    """
    Save a new tick (climb attempt record).
    """
    saveTick(input: SaveTickInput!): Tick!

    """
    Delete a tick (climb attempt record). Only the owner can delete.
    """
    deleteTick(uuid: ID!): Boolean!

    """
    Update an existing tick. Only the owner can update their own ticks.
    """
    updateTick(uuid: ID!, input: UpdateTickInput!): Tick!

    """
    Attach an Instagram or TikTok video as beta for a climb. Idempotent on
    (boardType, climbUuid, link).
    """
    attachBetaLink(input: AttachBetaLinkInput!): Boolean!

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

    """
    Update an existing climb. The caller must own the climb, and the climb
    must either still be a draft or have been published within the last 24
    hours. Used by the create form to let users keep tweaking a freshly
    published climb.
    """
    updateClimb(input: UpdateClimbInput!): UpdateClimbResult!

    """
    Delete one of the current user's unpublished draft climbs.
    Published climbs cannot be deleted through this mutation.
    """
    deleteDraftClimb(uuid: ID!, boardType: String!): Boolean!

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
    Reorder a climb within a playlist by moving it to a new index (owner only).
    """
    reorderPlaylistClimb(input: ReorderPlaylistClimbInput!): Boolean!

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
    Pin a playlist to the authenticated user's library. Idempotent.
    Pinning is per-user; the same playlist can be pinned by many users.
    Only playlists the user can access (own or public) may be pinned.
    """
    pinPlaylist(input: PinPlaylistInput!): Boolean!

    """
    Unpin a playlist. Idempotent.
    """
    unpinPlaylist(input: PinPlaylistInput!): Boolean!

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

    """
    Pin a board to the front of the viewer's board list. Idempotent — re-pinning
    an already-pinned board keeps its original pin time, so pinning something
    else never reshuffles it.
    """
    pinBoard(input: PinBoardInput!): Boolean!

    """
    Unpin a board. Idempotent; returns true even when it was not pinned.
    """
    unpinBoard(input: PinBoardInput!): Boolean!

    """
    Record that the viewer opened this board, which is what orders "Your boards"
    by recency. Never moves the stored timestamp backwards, so an out-of-order
    or replayed call is harmless.
    """
    recordBoardOpened(input: RecordBoardOpenedInput!): Boolean!

    """
    Record the board configuration seen when connecting to a controller over
    BLE, keyed by serial. Upserts the current user's serial→config recording.
    Returns null when a saved board already matches the connect (nothing to record).
    """
    recordBoardSerial(input: RecordBoardSerialInput!): BoardSerialConfig

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
    Link or unlink a board you own to/from a gym. Unlinking is always yours to
    do. Linking needs either owner/admin rights on the gym, or — so a climber can
    list their board at the gym they actually climb at — a public gym within
    150 m of the board's coordinates, subject to a per-caller cap.
    """
    linkBoardToGym(input: LinkBoardToGymInput!): Boolean!

    """
    Attach a stray board (surfaced by strayBoardsForGym) to a gym in one tap.
    Re-points the board's gym_id to this gym. The caller need not own the board;
    the gate is edit access to the target gym, and the board must be a genuine
    stray candidate for it (a merged-twin board or a nearby unlinked/SYSTEM one).
    """
    attachBoardToGym(input: AttachBoardToGymInput!): Boolean!

    """
    Remove a board from this gym's listing. Gated on edit access to the gym, and
    the board must currently be listed at it. Lets gym staff undo an unwanted
    self-link; clears gym_id only, leaving the board with its owner.
    """
    detachBoardFromGym(input: DetachBoardFromGymInput!): Boolean!

    """
    Grant a user write (editor) access to a gym: edit details only, no
    membership/board management, no delete. Callable by the gym owner, a gym
    admin, or a community admin/leader for one of the gym's board types.
    """
    grantGymWriteAccess(input: GrantGymWriteAccessInput!): Boolean!

    """
    Revoke a user's write (editor) access to a gym. Only removes editors —
    never a gym admin or plain member. Same authorization as grantGymWriteAccess.
    """
    revokeGymWriteAccess(input: RevokeGymWriteAccessInput!): Boolean!

    """
    Request ownership of a gym. With a matching work email at the gym's website
    domain, a verification email is sent and clicking it transfers ownership.
    Otherwise the claim is queued for admin review (and admin@boardsesh.com is
    notified). Requires authentication.
    """
    requestGymClaim(input: RequestGymClaimInput!): RequestGymClaimResult!

    """
    Approve or deny a pending gym claim (admin only). Approving transfers
    ownership to the claimant.
    """
    reviewGymClaim(input: ReviewGymClaimInput!): Boolean!

    """
    Fold one or more duplicate gyms into a canonical survivor (admin only). Every
    duplicate's boards, follows, members, claims, kiosks, comments, feed items,
    notifications, and votes re-point to the survivor, then each duplicate is
    soft-deleted with a pointer to it. Returns per-duplicate moved counts and any
    kiosk-slug-change warnings.
    """
    mergeGyms(input: MergeGymsInput!): MergeGymsResult!

    """
    Dismiss a candidate duplicate cluster (admin only). Records that the cluster is
    not a duplicate so the review queue hides it. Touches no gym row.
    """
    dismissGymCluster(input: DismissGymClusterInput!): Boolean!

    """
    Clear a gym or board's human-curation freeze (global admin only). This does
    not run a source sync, reverse ownership, or restore a soft-deleted row; it
    only permits a later matching source refresh and writes an audit record.
    """
    clearLocationSyncFreeze(input: ClearLocationSyncFreezeInput!): ClearLocationSyncFreezeResult!

    """
    Move a gym's ownership to another account (global admin only) — a sold gym,
    a departed committee member, a claim approved to the wrong person. The
    listing's human-curation freeze is left exactly as it was, the outgoing
    owner is kept on as a gym admin, and the handover is written to a durable
    audit trail. No self-serve entry point exists.
    """
    reassignGymOwner(input: ReassignGymOwnerInput!): ReassignGymOwnerResult!

    """
    Store a hand-corrected silhouette for one hold, replacing whatever the tracer
    produced (admin only, scoped to the board). Latest write wins — there is no
    revision history, so the note is the record of why.
    """
    upsertHoldOutlineOverride(input: UpsertHoldOutlineOverrideInput!): HoldOutlineOverride!

    """
    Drop a hold's correction and fall back to the traced silhouette (admin only,
    scoped to the board). True when a row was removed, false when there was
    nothing to remove.
    """
    deleteHoldOutlineOverride(input: DeleteHoldOutlineOverrideInput!): Boolean!

    """
    Report that two gym listings are the same gym (any signed-in user). Surfaces the
    pair to admins for review in the merge queue. Rate-limited and de-duplicated per
    pair so repeated reports don't spam the team.
    """
    reportGymDuplicate(input: ReportGymDuplicateInput!): ReportGymDuplicateResult!

    # ============================================
    # Gym Kiosk Mutations (require gym edit access)
    # ============================================

    """
    Create a kiosk (smart-TV wall dashboard) under a gym. Requires gym edit
    access. The slug is derived from the name (and made unique per gym) when
    omitted. Starts with an empty layout — assign boards via updateGymKiosk. Fails
    when the gym already has the maximum number of kiosks.
    """
    createGymKiosk(input: CreateGymKioskInput!): GymKiosk!

    """
    Update a kiosk's name, slug, and/or layout. Requires gym edit access. A
    supplied layout is strictly validated (@boardsesh/kiosk KioskLayoutSchema) and
    persisted as the schema-parsed output — every referenced board must be alive
    and linked to this kiosk's gym.
    """
    updateGymKiosk(input: UpdateGymKioskInput!): GymKiosk!

    """
    Soft-delete a kiosk. Requires gym edit access. The slug is freed for reuse.
    """
    deleteGymKiosk(kioskUuid: ID!): Boolean!

    """
    Public, unauthenticated kiosk check-in. A kiosk TV page calls this on load
    and on its config-poll cadence; after validating the kiosk exists, the
    backend records an ephemeral last-seen timestamp (Redis, ~30-day TTL) that
    the edit-guarded gymKiosks query surfaces. Returns false when the
    kiosk/gym pair doesn't resolve to a live kiosk. Rate-limited per client.
    """
    kioskHeartbeat(input: KioskHeartbeatInput!): Boolean!

    """
    Record that an explicitly-created session has been mirrored to Apple HealthKit,
    storing the workout UUID for de-duplication and UI status.
    Must be a participant of the session.
    """
    setSessionHealthKitWorkoutId(sessionId: ID!, workoutId: String!): Boolean!

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

    # ============================================
    # APNs Push Token Mutations (auth required)
    # ============================================

    """
    Register an APNs device token for Live Activity push updates in a session.
    Caller must be authenticated and be a participant in the session.
    Upserts: if the token already exists, updates the associated session.
    """
    registerActivityPushToken(sessionId: ID!, token: String!): Boolean!

    """
    Unregister an APNs device token for Live Activity push updates.
    Caller must be authenticated and be a participant in the session.
    The delete is scoped to (token, sessionId) so a leaked token cannot
    be used to clear another session's registration.
    """
    unregisterActivityPushToken(sessionId: ID!, token: String!): Boolean!

    # ESP32 sends LED positions from official app Bluetooth
    # frames: Pre-built frames string from ESP32 (preferred)
    # positions: Legacy LED positions array (for backwards compatibility)
    # Requires controller API key in connectionParams
    setClimbFromLedPositions(sessionId: ID!, frames: String, positions: [LedCommandInput!]): ClimbMatchResult!
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

    # ============================================
    # App Feedback Mutations (public)
    # ============================================

    """
    Submit in-app rating + optional comment. Public — unauthenticated testers
    can still rate. If the request has a valid auth token, the feedback row is
    associated with the user.
    """
    submitAppFeedback(input: SubmitAppFeedbackInput!): Boolean!

    """
    Update the triage status of a feedback row from the admin dashboard. Admin
    only. Moving to \`resolved\`/\`wont_fix\` stamps the resolver + timestamp;
    moving back to \`new\`/\`in_progress\` clears them. Returns the updated row.
    """
    updateAppFeedbackStatus(input: UpdateAppFeedbackStatusInput!): AppFeedbackReport!

    """
    Crowdsourced QA: file a verdict on a pull-request preview. Tester role
    required; the PR must be open; a \`declined\` verdict needs a comment of
    10+ characters. Stores the row, then (best effort, never failing the
    mutation) posts a comment on the PR and swaps the qa-approved/qa-declined
    label.
    """
    submitQaVerdict(input: SubmitQaVerdictInput!): QaVerdict!

    # ============================================
    # External Platform Integration Mutations
    # ============================================

    """
    Mint a short-lived, single-use handoff code for starting the provider's
    browser OAuth flow (GET /integrations/:provider/start?handoff=...). Keeps
    the session token out of URLs, where it would persist in logs and browser
    history. Requires authentication.
    """
    createIntegrationOAuthHandoff(provider: IntegrationProvider!): String!

    """
    Unlink an external platform integration. Revokes the token on the
    provider's side (best-effort) and deletes the stored credentials.
    Requires authentication.
    """
    disconnectIntegration(provider: IntegrationProvider!): Boolean!

    """
    Toggle automatic upload of finished sessions for a connected integration.
    Requires authentication.
    """
    setIntegrationAutoSync(provider: IntegrationProvider!, enabled: Boolean!): IntegrationStatus!

    """
    Export an ended session to an external platform. Idempotent: returns the
    existing export when the session was already uploaded (e.g. by auto-sync).
    Caller must be a participant of the session. Requires authentication.
    """
    syncSessionToIntegration(provider: IntegrationProvider!, sessionId: ID!): IntegrationExportResult!
  }
`;
