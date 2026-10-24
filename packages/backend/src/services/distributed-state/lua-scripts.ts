/**
 * Lua script for atomic leader election.
 * Atomically sets both the leader key (with TTL) AND the isLeader flag on the connection hash.
 * This prevents race conditions where process crashes between operations.
 * Returns: 1 if leader was set, 0 if leader already exists
 */
export const LEADER_ELECTION_SCRIPT = `
  local leaderKey = KEYS[1]
  local connKey = KEYS[2]
  local connectionId = ARGV[1]
  local leaderTTL = tonumber(ARGV[2])

  -- Check if leader already exists
  local currentLeader = redis.call('GET', leaderKey)
  if currentLeader then
    return 0
  end

  -- Atomically set this connection as leader with TTL AND update isLeader flag
  redis.call('SET', leaderKey, connectionId, 'EX', leaderTTL)
  redis.call('HSET', connKey, 'isLeader', 'true')
  return 1
`;

/**
 * Lua script to elect new leader from session members.
 * Picks the member with the earliest connectedAt timestamp.
 * Also clears the old leader's isLeader flag and refreshes TTL.
 * Returns: connectionId of new leader, or nil if no members
 *
 * Note: This script clears isLeader for the old leader regardless of whether
 * they are the leaving connection. This ensures no stale isLeader flags remain
 * even if the calling code order changes (e.g., if script runs before connection deletion).
 */
export const ELECT_NEW_LEADER_SCRIPT = `
  local sessionMembersKey = KEYS[1]
  local leaderKey = KEYS[2]
  local leavingConnectionId = ARGV[1]
  local membersTTL = tonumber(ARGV[2])
  local leaderTTL = tonumber(ARGV[3])

  -- Get and clear old leader's isLeader flag first (including leaving connection for robustness)
  local oldLeader = redis.call('GET', leaderKey)
  if oldLeader then
    local oldLeaderConnKey = 'boardsesh:conn:' .. oldLeader
    if redis.call('EXISTS', oldLeaderConnKey) == 1 then
      redis.call('HSET', oldLeaderConnKey, 'isLeader', 'false')
    end
  end

  -- Get all members except the leaving one
  local members = redis.call('SMEMBERS', sessionMembersKey)
  local candidates = {}

  for _, memberId in ipairs(members) do
    if memberId ~= leavingConnectionId then
      local connKey = 'boardsesh:conn:' .. memberId
      local connectedAt = redis.call('HGET', connKey, 'connectedAt')
      if connectedAt then
        table.insert(candidates, {memberId, tonumber(connectedAt)})
      end
    end
  end

  -- No candidates left
  if #candidates == 0 then
    redis.call('DEL', leaderKey)
    return nil
  end

  -- Sort by connectedAt (earliest first)
  table.sort(candidates, function(a, b) return a[2] < b[2] end)

  local newLeaderId = candidates[1][1]

  -- Set new leader with TTL
  redis.call('SET', leaderKey, newLeaderId, 'EX', leaderTTL)

  -- Update isLeader flag on the new leader connection
  local connKey = 'boardsesh:conn:' .. newLeaderId
  redis.call('HSET', connKey, 'isLeader', 'true')

  -- Refresh TTL on session members set to prevent expiry during long sessions
  if membersTTL and membersTTL > 0 then
    redis.call('EXPIRE', sessionMembersKey, membersTTL)
  end

  return newLeaderId
`;

/**
 * Lua script for atomic leave session operation.
 * Atomically checks leader status, updates connection, removes from session, and elects new leader.
 * This prevents race conditions where leader status could change between read and update.
 * Returns: newLeaderId if was leader and new leader elected, empty string if was leader but no candidates, nil if not leader
 */
export const LEAVE_SESSION_SCRIPT = `
  local connKey = KEYS[1]
  local sessionMembersKey = KEYS[2]
  local leaderKey = KEYS[3]
  -- participantConnections set of the LEAVING participant. '' when the caller
  -- didn't supply a participant identity (see the same-participant preference
  -- in the election below).
  local participantConnectionsKey = KEYS[4]
  local connectionId = ARGV[1]
  local membersTTL = tonumber(ARGV[2])
  local leaderTTL = tonumber(ARGV[3])

  -- Get current leader to check if this connection is leader (atomically)
  local currentLeader = redis.call('GET', leaderKey)
  local wasLeader = (currentLeader == connectionId)

  -- Update connection state, but only if the hash still exists. An
  -- unconditional HMSET would resurrect a deleted connection hash with no
  -- TTL and no connectionId field, leaving a zombie key that leaks forever.
  -- A concurrent removeConnection on another instance (e.g. WS disconnect
  -- racing this leave) may already have deleted it.
  if redis.call('EXISTS', connKey) == 1 then
    redis.call('HMSET', connKey, 'sessionId', '', 'participantId', '', 'isLeader', 'false')
  end

  -- Remove from session members
  redis.call('SREM', sessionMembersKey, connectionId)

  -- If not leader, return nil (no leader election needed)
  if not wasLeader then
    return nil
  end

  -- Was leader, need to elect new one
  local members = redis.call('SMEMBERS', sessionMembersKey)

  -- Same-participant preference (#2135 crit C): when the leader CONNECTION
  -- leaves but its participant still holds another live connection (e.g. a
  -- multi-tab authenticated user leaving one tab), keep leadership with that
  -- same participant. SessionUser.isLeader is derived from the leader
  -- connection's participantId, so moving the leader key to a sibling
  -- connection of the same participant produces NO user-facing LeaderChanged,
  -- instead of spuriously handing leadership to a different participant who
  -- happens to have connected earlier.
  local sameParticipantConns = {}
  if participantConnectionsKey and participantConnectionsKey ~= '' then
    local pconns = redis.call('SMEMBERS', participantConnectionsKey)
    for _, id in ipairs(pconns) do
      sameParticipantConns[id] = true
    end
  end

  local candidates = {}
  local preferred = {}

  for _, memberId in ipairs(members) do
    if memberId ~= connectionId then
      local memberConnKey = 'boardsesh:conn:' .. memberId
      local connectedAt = redis.call('HGET', memberConnKey, 'connectedAt')
      if connectedAt then
        local entry = {memberId, tonumber(connectedAt)}
        table.insert(candidates, entry)
        if sameParticipantConns[memberId] then
          table.insert(preferred, entry)
        end
      end
    end
  end

  -- Prefer a sibling connection of the leaving participant when one exists.
  local pool = candidates
  if #preferred > 0 then
    pool = preferred
  end

  -- No candidates left
  if #pool == 0 then
    redis.call('DEL', leaderKey)
    return ''  -- Empty string means was leader but no new leader
  end

  -- Sort by connectedAt (earliest first)
  table.sort(pool, function(a, b) return a[2] < b[2] end)

  local newLeaderId = pool[1][1]

  -- Set new leader with TTL
  redis.call('SET', leaderKey, newLeaderId, 'EX', leaderTTL)

  -- Update isLeader flag on new leader
  local newLeaderConnKey = 'boardsesh:conn:' .. newLeaderId
  redis.call('HSET', newLeaderConnKey, 'isLeader', 'true')

  -- Refresh session members TTL
  if membersTTL and membersTTL > 0 then
    redis.call('EXPIRE', sessionMembersKey, membersTTL)
  end

  return newLeaderId
`;

/**
 * Lua script for atomic session join with leader election.
 * Atomically updates connection, adds to session members, and attempts leader election.
 * This prevents race conditions where a crash between these operations could leave
 * a connection in the members set without proper leader election.
 * Returns: 1 if became leader, 0 if not
 */
export const JOIN_SESSION_SCRIPT = `
  local connKey = KEYS[1]
  local sessionMembersKey = KEYS[2]
  local leaderKey = KEYS[3]
  local sessionParticipantsKey = KEYS[4]
  local participantKey = KEYS[5]
  local participantConnectionsKey = KEYS[6]
  local connectionId = ARGV[1]
  local sessionId = ARGV[2]
  local connTTL = tonumber(ARGV[3])
  local sessionTTL = tonumber(ARGV[4])
  local username = ARGV[5]
  local avatarUrl = ARGV[6]
  local participantId = ARGV[7]
  local now = ARGV[8]
  local UNSET = '__UNSET__'

  -- Refuse to join if the connection hash has been reaped (TTL, manual DEL,
  -- or instance cleanup). HSETs on a missing key would resurrect it as a
  -- partial hash without connectionId / instanceId / connectedAt and (after
  -- the EXPIRE) with a fresh TTL. Better to fail fast and let the caller
  -- re-register.
  if redis.call('EXISTS', connKey) == 0 then
    return -1
  end

  -- Update connection with session info
  redis.call('HSET', connKey, 'sessionId', sessionId)
  if username and username ~= '' and username ~= UNSET then
    redis.call('HSET', connKey, 'username', username)
  end
  -- Only update avatarUrl if explicitly provided (not the sentinel value).
  -- Empty string is valid (means clear avatar), sentinel means don't update.
  if avatarUrl ~= UNSET then
    redis.call('HSET', connKey, 'avatarUrl', avatarUrl)
  end
  redis.call('EXPIRE', connKey, connTTL)

  -- Add to session members
  redis.call('SADD', sessionMembersKey, connectionId)
  redis.call('EXPIRE', sessionMembersKey, sessionTTL)

  -- Participant identity: bind the connection to its participant and write
  -- the participant hash atomically with the membership update. Previously
  -- this was a follow-up multi() in the JS caller; that left a brief window
  -- where the connection was in sessionMembers but absent from
  -- sessionParticipants, so getSessionMembers fell back to the
  -- connection-keyed branch and returned id=connectionId for one tick before
  -- the multi completed and the user reappeared with id=participantId.
  -- Doing it all here collapses that flicker.
  redis.call('HSET', connKey, 'participantId', participantId)
  local resolvedUsername = redis.call('HGET', connKey, 'username') or ''
  local resolvedAvatarUrl = redis.call('HGET', connKey, 'avatarUrl') or ''
  local resolvedUserId = redis.call('HGET', connKey, 'userId') or ''
  redis.call('SADD', sessionParticipantsKey, participantId)
  redis.call('EXPIRE', sessionParticipantsKey, sessionTTL)
  redis.call('HMSET', participantKey,
    'participantId', participantId,
    'sessionId', sessionId,
    'userId', resolvedUserId,
    'username', resolvedUsername,
    'avatarUrl', resolvedAvatarUrl,
    'connectionState', 'CONNECTED',
    'lastSeenAt', now)
  redis.call('EXPIRE', participantKey, sessionTTL)
  redis.call('SADD', participantConnectionsKey, connectionId)
  redis.call('EXPIRE', participantConnectionsKey, sessionTTL)

  -- Try to become leader (only if no leader exists)
  local currentLeader = redis.call('GET', leaderKey)
  if currentLeader then
    return 0  -- Already has a leader
  end

  -- Become leader
  redis.call('SET', leaderKey, connectionId, 'EX', sessionTTL)
  redis.call('HSET', connKey, 'isLeader', 'true')
  return 1
`;

/**
 * Lua script for atomic TTL refresh of connection and session membership.
 * Atomically refreshes both TTLs based on the connection's current session.
 * Returns: 1 if successful, 0 if connection doesn't exist
 *
 * CLUSTER-UNSAFE: builds session-* / participant-* / leader keys via string
 * concatenation inside the script body instead of passing them in via
 * KEYS[]. Redis Cluster would reject this because all touched keys must
 * be declared up front and hash to the same slot. Tracked as part of
 * issue #2143's A3 follow-up; the fix needs a coordinated change to
 * either pass every key as a separate KEYS entry or adopt hash tags
 * (e.g. `boardsesh:{sessionId}:...`) so the cluster proxy can route
 * them together.
 */
export const REFRESH_TTL_SCRIPT = `
  local connKey = KEYS[1]
  local connTTL = tonumber(ARGV[1])
  local sessionTTL = tonumber(ARGV[2])

  -- Check if connection exists
  if redis.call('EXISTS', connKey) == 0 then
    return 0
  end

  -- Refresh connection TTL
  redis.call('EXPIRE', connKey, connTTL)

  -- Get session ID and refresh session membership TTL if in a session
  local sessionId = redis.call('HGET', connKey, 'sessionId')
  if sessionId and sessionId ~= '' then
    local sessionMembersKey = 'boardsesh:session:' .. sessionId .. ':members'
    local sessionLeaderKey = 'boardsesh:session:' .. sessionId .. ':leader'
    redis.call('EXPIRE', sessionMembersKey, sessionTTL)
    -- Also refresh the leader key. Without this, a long-running session
    -- (>= sessionTTL of activity) drops its leader key when the original
    -- election TTL expires; the next mutation triggers a fresh election and
    -- clients see a surprise LeaderChanged mid-session for no apparent
    -- reason. Touching it on every connection refresh keeps it alive as
    -- long as any connection in the session is still alive. EXPIRE on a
    -- missing key is a no-op, so this is safe when the leader has just
    -- handed off and the key is briefly absent.
    redis.call('EXPIRE', sessionLeaderKey, sessionTTL)

    local participantId = redis.call('HGET', connKey, 'participantId')
    if participantId and participantId ~= '' then
      local sessionParticipantsKey = 'boardsesh:session:' .. sessionId .. ':participants'
      local participantKey = 'boardsesh:participant:' .. sessionId .. ':' .. participantId
      local participantConnectionsKey = 'boardsesh:participant:' .. sessionId .. ':' .. participantId .. ':connections'
      redis.call('EXPIRE', sessionParticipantsKey, sessionTTL)
      redis.call('EXPIRE', participantKey, sessionTTL)
      redis.call('EXPIRE', participantConnectionsKey, sessionTTL)
    end
  end

  return 1
`;

/**
 * Lua script for atomic full-participant eviction.
 * Reads the participant's connection set inside the script, then SREMs the
 * participant from sessionParticipants, deletes the participant + connection
 * set, and for every connectionId in the snapshot SREMs it from sessionMembers
 * and clears its connection hash. All in one round-trip, so a concurrent join
 * adding a fresh connection to participantConnections cannot have its work
 * silently wiped between our read and our writes.
 *
 * The sibling KEYS.connection() keys are still computed inside the script via
 * string concatenation; this keeps consistency with the rest of the file but
 * is documented as a Redis-cluster portability concern in issue #2143.
 * KEYS[1] = sessionParticipants set key
 * KEYS[2] = participant hash key
 * KEYS[3] = participantConnections set key
 * KEYS[4] = sessionMembers set key
 * ARGV[1] = participantId being evicted
 * Returns: number of connection slots cleaned up
 */
export const REMOVE_PARTICIPANT_SCRIPT = `
  local sessionParticipantsKey = KEYS[1]
  local participantKey = KEYS[2]
  local participantConnectionsKey = KEYS[3]
  local sessionMembersKey = KEYS[4]
  local participantId = ARGV[1]

  local connectionIds = redis.call('SMEMBERS', participantConnectionsKey)
  redis.call('SREM', sessionParticipantsKey, participantId)
  redis.call('DEL', participantKey)
  redis.call('DEL', participantConnectionsKey)
  for _, connectionId in ipairs(connectionIds) do
    redis.call('SREM', sessionMembersKey, connectionId)
    local connKey = 'boardsesh:conn:' .. connectionId
    if redis.call('EXISTS', connKey) == 1 then
      redis.call('HMSET', connKey, 'sessionId', '', 'participantId', '', 'isLeader', 'false')
    end
  end
  return #connectionIds
`;

/**
 * Lua script for atomic username/avatar update across the connection hash
 * AND the participant hash.
 *
 * The previous code only wrote to the connection hash. But once a session
 * has `sessionParticipants`, `getSessionMembers` returns username/avatar
 * from the participant hash — so updating only the connection silently left
 * the participant entry stale and peers saw the old name until the next
 * full session refresh.
 *
 * KEYS[1] = connection hash key
 * ARGV[1] = username
 * ARGV[2] = avatarUrl (sentinel '__UNSET__' = don't touch)
 * ARGV[3] = session TTL
 * Returns: 1 if update succeeded, 0 if connection hash is missing
 */
// CLUSTER-UNSAFE: same pattern as REFRESH_TTL_SCRIPT — builds
// participantKey via string concatenation rather than KEYS[]. Tracked
// under issue #2143's A3 follow-up.
export const UPDATE_USERNAME_SCRIPT = `
  local connKey = KEYS[1]
  local username = ARGV[1]
  local avatarUrl = ARGV[2]
  local sessionTTL = tonumber(ARGV[3])
  local UNSET = '__UNSET__'

  if redis.call('EXISTS', connKey) == 0 then
    return 0
  end

  redis.call('HSET', connKey, 'username', username)
  if avatarUrl ~= UNSET then
    redis.call('HSET', connKey, 'avatarUrl', avatarUrl)
  end
  -- Refresh the connection TTL too — we just wrote to it, treat that as
  -- activity. REFRESH_TTL_SCRIPT picks this up on the next heartbeat
  -- regardless, but doing it here keeps username changes from accidentally
  -- inheriting a stale TTL when the rename arrives just before expiry.
  redis.call('EXPIRE', connKey, sessionTTL)

  local sessionId = redis.call('HGET', connKey, 'sessionId')
  local participantId = redis.call('HGET', connKey, 'participantId')
  if sessionId and sessionId ~= '' and participantId and participantId ~= '' then
    local participantKey = 'boardsesh:participant:' .. sessionId .. ':' .. participantId
    if redis.call('EXISTS', participantKey) == 1 then
      redis.call('HSET', participantKey, 'username', username)
      if avatarUrl ~= UNSET then
        redis.call('HSET', participantKey, 'avatarUrl', avatarUrl)
      end
      redis.call('EXPIRE', participantKey, sessionTTL)
    end
  end

  return 1
`;

/**
 * Lua script for atomic participant-connection removal.
 * SREM the connection from the participant's connection set, then either return
 * the remaining count (if > 0) or atomically clean up the participant record
 * and remove from session participants. Closing the read-then-delete race in
 * the prior multi() implementation: a concurrent re-join that re-adds to the
 * connection set between our SREM and DEL would otherwise be wiped out.
 * KEYS[1] = participantConnections set key
 * KEYS[2] = sessionParticipants set key
 * KEYS[3] = participant hash key
 * ARGV[1] = connectionId being removed
 * ARGV[2] = participantId being removed
 * Returns: remaining connection count after removal (0 means participant cleaned up)
 */
export const REMOVE_PARTICIPANT_CONNECTION_SCRIPT = `
  local participantConnectionsKey = KEYS[1]
  local sessionParticipantsKey = KEYS[2]
  local participantKey = KEYS[3]
  local connectionId = ARGV[1]
  local participantId = ARGV[2]

  redis.call('SREM', participantConnectionsKey, connectionId)
  local remaining = redis.call('SCARD', participantConnectionsKey)
  if remaining > 0 then
    return remaining
  end

  redis.call('SREM', sessionParticipantsKey, participantId)
  redis.call('DEL', participantKey)
  redis.call('DEL', participantConnectionsKey)
  return 0
`;

/**
 * Lua script to prune stale members from a session.
 * For each member in the session set, checks if the connection hash still exists.
 * Removes stale entries, re-elects leader if needed, and cleans up empty sessions.
 * KEYS[1] = session members key
 * KEYS[2] = session leader key
 * ARGV[1] = session TTL
 * Returns: number of stale members removed
 */
export const PRUNE_STALE_SESSION_MEMBERS_SCRIPT = `
  local sessionMembersKey = KEYS[1]
  local leaderKey = KEYS[2]
  local sessionTTL = tonumber(ARGV[1])

  local members = redis.call('SMEMBERS', sessionMembersKey)
  local staleCount = 0
  local leaderRemoved = false
  local currentLeader = redis.call('GET', leaderKey)

  for _, memberId in ipairs(members) do
    local connKey = 'boardsesh:conn:' .. memberId
    if redis.call('EXISTS', connKey) == 0 then
      -- Connection hash expired/missing — this member is stale
      redis.call('SREM', sessionMembersKey, memberId)
      staleCount = staleCount + 1
      if currentLeader == memberId then
        leaderRemoved = true
      end
    end
  end

  -- If no stale members removed, nothing else to do
  if staleCount == 0 then
    return 0
  end

  -- Check remaining members
  local remaining = redis.call('SMEMBERS', sessionMembersKey)
  if #remaining == 0 then
    -- Session is empty, clean up
    redis.call('DEL', sessionMembersKey)
    redis.call('DEL', leaderKey)
    return staleCount
  end

  -- Re-elect leader if needed
  if leaderRemoved then
    -- Find the earliest connected remaining member
    local candidates = {}
    for _, memberId in ipairs(remaining) do
      local connKey = 'boardsesh:conn:' .. memberId
      local connectedAt = redis.call('HGET', connKey, 'connectedAt')
      if connectedAt then
        table.insert(candidates, {memberId, tonumber(connectedAt)})
      end
    end

    if #candidates == 0 then
      redis.call('DEL', leaderKey)
    else
      -- Clear old leader flag if their connection still exists
      if currentLeader then
        local oldConnKey = 'boardsesh:conn:' .. currentLeader
        if redis.call('EXISTS', oldConnKey) == 1 then
          redis.call('HSET', oldConnKey, 'isLeader', 'false')
        end
      end

      table.sort(candidates, function(a, b) return a[2] < b[2] end)
      local newLeaderId = candidates[1][1]
      redis.call('SET', leaderKey, newLeaderId, 'EX', sessionTTL)
      local newLeaderConnKey = 'boardsesh:conn:' .. newLeaderId
      redis.call('HSET', newLeaderConnKey, 'isLeader', 'true')
    end
  end

  -- Refresh TTL on session members set
  if sessionTTL and sessionTTL > 0 then
    redis.call('EXPIRE', sessionMembersKey, sessionTTL)
  end

  return staleCount
`;

/**
 * Lua script to mark a participant RECONNECTING, but ONLY when it currently has
 * no live connection (#2135 crit D — "passive disconnect cannot overwrite a
 * fresher connected state").
 *
 * A passive WebSocket drop parks the participant in the grace window. But a
 * reconnect that lands on ANOTHER connection during the disconnect cleanup
 * (common on flaky networks / two-tab users) has already promoted the
 * participant back to CONNECTED via JOIN_SESSION_SCRIPT. Marking RECONNECTING
 * afterwards would clobber that fresher state and emit a spurious
 * UserPresenceChanged. Reading the live-connection presence and doing the
 * conditional write in one round-trip closes that read-then-write window.
 *
 * KEYS[1] = participant hash
 * KEYS[2] = participantConnections set
 * KEYS[3] = sessionParticipants set
 * ARGV[1] = now (ms, for lastSeenAt)
 * ARGV[2] = session TTL
 * Returns: 'MISSING' (no participant hash), 'HAS_LIVE' (a live connection
 *          exists — not marked), or 'RECONNECTING' (marked).
 */
export const MARK_RECONNECTING_IF_IDLE_SCRIPT = `
  local participantKey = KEYS[1]
  local participantConnectionsKey = KEYS[2]
  local sessionParticipantsKey = KEYS[3]
  local now = ARGV[1]
  local sessionTTL = tonumber(ARGV[2])

  if redis.call('EXISTS', participantKey) == 0 then
    return 'MISSING'
  end

  -- A live connection means a reconnect already promoted this participant back
  -- to CONNECTED. Leave it alone.
  local connectionIds = redis.call('SMEMBERS', participantConnectionsKey)
  for _, connectionId in ipairs(connectionIds) do
    if redis.call('EXISTS', 'boardsesh:conn:' .. connectionId) == 1 then
      return 'HAS_LIVE'
    end
  end

  redis.call('HSET', participantKey, 'connectionState', 'RECONNECTING', 'lastSeenAt', now)
  redis.call('EXPIRE', participantKey, sessionTTL)
  redis.call('EXPIRE', sessionParticipantsKey, sessionTTL)
  return 'RECONNECTING'
`;

/**
 * Lua script for atomic, conditional grace-timer eviction (#2135 crit B +
 * expiry leader election). Ties the "is this participant still a ghost?" check
 * and the removal + leader re-election into a single round-trip.
 *
 * The prior code checked live-connection count OUTSIDE the delete
 * (getParticipantLiveConnectionCount -> removeParticipant), so a reconnect that
 * added a live connection between the check and the unconditional delete was
 * wiped out — a zombie connection whose next mutation trips requireSession, and
 * the participant vanished from the roster. This script only evicts when the
 * participant is STILL parked RECONNECTING with zero live connections, all
 * evaluated atomically. And because REMOVE_PARTICIPANT_SCRIPT never touched the
 * leader key, evicting a ghost that held leadership left the session leaderless
 * with no LeaderChanged; this re-elects the earliest-connected remaining member
 * in the same transition so no LeaderChanged is missed.
 *
 * KEYS[1] = sessionParticipants set
 * KEYS[2] = participant hash
 * KEYS[3] = participantConnections set
 * KEYS[4] = sessionMembers set
 * KEYS[5] = sessionLeader key
 * ARGV[1] = participantId being evicted
 * ARGV[2] = session TTL (also used as the new leader key TTL)
 * Returns: { status, newLeaderId }
 *   status = 'MISSING' | 'NOT_RECONNECTING' | 'HAS_LIVE' | 'EVICTED'
 *   newLeaderId = connectionId of a newly elected leader, or '' (no change /
 *                 none remaining / participant wasn't leader).
 */
export const EVICT_PARTICIPANT_IF_GHOST_SCRIPT = `
  local sessionParticipantsKey = KEYS[1]
  local participantKey = KEYS[2]
  local participantConnectionsKey = KEYS[3]
  local sessionMembersKey = KEYS[4]
  local leaderKey = KEYS[5]
  local participantId = ARGV[1]
  local sessionTTL = tonumber(ARGV[2])

  if redis.call('EXISTS', participantKey) == 0 then
    return { 'MISSING', '' }
  end

  -- Only evict a participant still parked in the grace window. A concurrent
  -- rejoin that already flipped it back to CONNECTED must not be evicted.
  if redis.call('HGET', participantKey, 'connectionState') ~= 'RECONNECTING' then
    return { 'NOT_RECONNECTING', '' }
  end

  -- Any live connection means a reconnect landed after the grace timer armed —
  -- this is the reconnect-before-expiry race. Spare the participant.
  local connectionIds = redis.call('SMEMBERS', participantConnectionsKey)
  for _, connectionId in ipairs(connectionIds) do
    if redis.call('EXISTS', 'boardsesh:conn:' .. connectionId) == 1 then
      return { 'HAS_LIVE', '' }
    end
  end

  -- Ghost confirmed. Remove the participant and detach every connection from
  -- the member set.
  redis.call('SREM', sessionParticipantsKey, participantId)
  redis.call('DEL', participantKey)
  redis.call('DEL', participantConnectionsKey)
  for _, connectionId in ipairs(connectionIds) do
    redis.call('SREM', sessionMembersKey, connectionId)
    local connKey = 'boardsesh:conn:' .. connectionId
    if redis.call('EXISTS', connKey) == 1 then
      redis.call('HMSET', connKey, 'sessionId', '', 'participantId', '', 'isLeader', 'false')
    end
  end

  -- Re-elect only when removal left a STALE leader: the leader key points at a
  -- connection that is no longer a live member (typically the ghost's own dead
  -- connection). We can't reliably match the leader back to the evicted
  -- participant by its connection set — a normal disconnect already SREM'd its
  -- connections from participantConnections before the grace timer fires, so
  -- that set is usually empty here. Checking the leader key's liveness directly
  -- is both correct for that case and a no-op when leadership already moved to a
  -- live member (e.g. removeConnection re-elected on disconnect). A nil leader
  -- is left alone — the next join elects.
  local currentLeader = redis.call('GET', leaderKey)
  local needElection = false
  if currentLeader then
    if redis.call('EXISTS', 'boardsesh:conn:' .. currentLeader) == 0
       or redis.call('SISMEMBER', sessionMembersKey, currentLeader) == 0 then
      needElection = true
    end
  end

  if not needElection then
    return { 'EVICTED', '' }
  end

  -- Elect a replacement leader in the same round-trip: earliest-connectedAt
  -- among the remaining members.
  local remaining = redis.call('SMEMBERS', sessionMembersKey)
  local candidates = {}
  for _, memberId in ipairs(remaining) do
    local connKey = 'boardsesh:conn:' .. memberId
    local connectedAt = redis.call('HGET', connKey, 'connectedAt')
    if connectedAt then
      table.insert(candidates, {memberId, tonumber(connectedAt)})
    end
  end

  if #candidates == 0 then
    redis.call('DEL', leaderKey)
    return { 'EVICTED', '' }
  end

  table.sort(candidates, function(a, b) return a[2] < b[2] end)
  local newLeaderId = candidates[1][1]
  redis.call('SET', leaderKey, newLeaderId, 'EX', sessionTTL)
  redis.call('HSET', 'boardsesh:conn:' .. newLeaderId, 'isLeader', 'true')
  if sessionTTL and sessionTTL > 0 then
    redis.call('EXPIRE', sessionMembersKey, sessionTTL)
  end
  return { 'EVICTED', newLeaderId }
`;

/**
 * Compare-and-set write of the session's shared rest clock (#5382).
 *
 * KEYS[1] = boardsesh:session:{id}:restCadence (HASH { rev, doc })
 * ARGV[1] = the revision the caller read
 * ARGV[2] = the next doc ('' = clock off)
 * ARGV[3] = TTL seconds (session membership)
 * ARGV[4] = the lowest revision this write may take (restCadenceRevisionFloor)
 *
 * Writes only when the stored revision still equals ARGV[1], so two instances
 * racing on one session can never both commit against the same read: the
 * loser gets the winner's { rev, doc } back and either retries or, for a FIRE,
 * reports that the beat was already claimed. One atomic script, never WATCH: a
 * WATCH belongs to the connection, so every concurrent caller on the shared
 * ioredis client would share (and clear) it.
 *
 * The new revision is max(rev + 1, ARGV[4]). A hash Redis lost (a restart from
 * an older snapshot, a lagging replica promoted, an expired key) reads as an
 * old revision, and without the floor the next write would land below what
 * every live phone holds, so they would all drop it.
 *
 * Both branches refresh the TTL, the losing one too: a refused write still
 * means a member is driving the clock, and the hash must not expire under a
 * session whose writes keep losing races.
 *
 * Returns { 1, newRev, doc } on commit, { 0, storedRev, storedDoc } otherwise.
 */
export const CAS_SESSION_REST_CADENCE_SCRIPT = `
  local cadenceKey = KEYS[1]
  local expectedRev = tonumber(ARGV[1])
  local nextDoc = ARGV[2]
  local ttl = tonumber(ARGV[3])
  local minimumRev = tonumber(ARGV[4]) or 0

  local storedRev = tonumber(redis.call('HGET', cadenceKey, 'rev') or '0') or 0
  if storedRev ~= expectedRev then
    local storedDoc = redis.call('HGET', cadenceKey, 'doc') or ''
    -- A losing write still proves the session is live. A no-op on a missing key.
    redis.call('EXPIRE', cadenceKey, ttl)
    return { 0, storedRev, storedDoc }
  end

  local nextRev = math.max(storedRev + 1, minimumRev)
  redis.call('HSET', cadenceKey, 'rev', tostring(nextRev), 'doc', nextDoc)
  redis.call('EXPIRE', cadenceKey, ttl)
  return { 1, nextRev, nextDoc }
`;
