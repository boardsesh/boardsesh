/**
 * Workout-aware sessions (#6903): the workout a climber followed in a session,
 * stored per climber per session and summarised from their ticks on read. See
 * docs/workout-stages.md, "Workouts on the server".
 *
 * The read queries are separate from sessionSummary / sessionDetail /
 * sessionGroupedFeed on purpose: new selections on those documents would trip
 * the pinned screenshot fixtures.
 */
export const sessionWorkoutsTypeDefs = /* GraphQL */ `
  "One queued climb of a workout block, captured when the run is written."
  input SessionWorkoutItemInput {
    queueItemUuid: ID!
    climbUuid: String!
    angle: Int!
    isMirror: Boolean
  }

  "A timed block's pacing. 4x4 adds repsPerSet and restBetweenSetsSeconds."
  input SessionWorkoutPacingInput {
    "onTheMinute or afterTick."
    mode: String!
    restSeconds: Int!
    advanceOn: String
    repsPerSet: Int
    restBetweenSetsSeconds: Int
  }

  input SessionWorkoutStageInput {
    "The run stage's id (a uuid)."
    id: ID!
    "A workout stage kind (warmUp, volume, fourByFour, ...). Any string, so a newer kind survives."
    kind: String!
    coolDown: Boolean
    "Difficulty id the block was built around."
    targetGrade: Int
    pacing: SessionWorkoutPacingInput
    items: [SessionWorkoutItemInput!]!
  }

  "Which queue item a tick was logged on."
  input SessionWorkoutTickInput {
    tickUuid: ID!
    queueItemUuid: ID!
  }

  input RecordSessionWorkoutInput {
    sessionId: ID!
    "The phone's per-session write counter. Only a higher revision than the stored one is written."
    revision: Int!
    stages: [SessionWorkoutStageInput!]!
    ticks: [SessionWorkoutTickInput!]!
  }

  "How one rep or climb of a workout ended."
  enum SessionWorkoutRepOutcome {
    FLASH
    SEND
    ATTEMPT
  }

  type SessionWorkoutClimb {
    queueItemUuid: ID!
    climbUuid: String!
    angle: Int!
    isMirror: Boolean
    name: String
    "Display grade: the climber's own when they logged it, else the consensus at this angle."
    grade: String
    boardType: String
    layoutId: Int
    frames: String
    renderBoard: RenderBoardConfig
    "One per tick on this climb, in tick order."
    reps: [SessionWorkoutRepOutcome!]!
    "The ticks behind reps, same order: only ticks the viewer may see, so a client can group the session's ticks by block."
    tickUuids: [ID!]!
    "True when the climber logged nothing on it."
    skipped: Boolean!
  }

  "Counts in ticks, the unit the session totals use."
  type SessionWorkoutTally {
    "Flash and send ticks."
    sent: Int!
    "Attempt ticks."
    attempts: Int!
    "Climbs of the block with no tick."
    skipped: Int!
    "Climbs in the block."
    climbs: Int!
  }

  type SessionWorkoutStage {
    id: ID!
    kind: String!
    isCoolDown: Boolean!
    "Display grade name of the block's target grade."
    targetGrade: String
    "A 4x4: reps per climb."
    repsPerSet: Int
    "A 4x4: one set per climb."
    sets: Int
    "On the minute: the interval."
    intervalSeconds: Int
    "A paced block's rest after each tick (a 4x4: between reps)."
    restSeconds: Int
    climbs: [SessionWorkoutClimb!]!
    tally: SessionWorkoutTally!
  }

  type SessionWorkout {
    userId: ID!
    displayName: String
    avatarUrl: String
    stages: [SessionWorkoutStage!]!
    "The climber's ticks in the session that match no climb of the workout."
    offPlan: Int!
    "The climber's ticks behind offPlan that the viewer may see."
    offPlanTickUuids: [ID!]!
    updatedAt: String!
  }

  "One line for a feed card: the main block, the second for 'A + B', how many more."
  type SessionWorkoutHeadline {
    sessionId: ID!
    userId: ID!
    mainKind: String
    "Display grade name of the main block's target grade."
    mainTargetGrade: String
    secondMainKind: String
    "Every block, warm-ups and cool-downs included."
    blockCount: Int!
    "Main blocks after the first."
    extraMainBlocks: Int!
  }

  extend type Query {
    """
    The workouts followed in a session, one per climber, with what each block
    came to. Follows sessionDetail: the session must open for the viewer, the
    climber must be someone its own surfaces name to them, and at least one of
    the climber's ticks in it must be visible to them. Climbs the viewer may not
    see are left out along with their ticks.
    """
    sessionWorkouts(sessionId: ID!): [SessionWorkout!]!

    """
    Feed-card headlines for up to 50 sessions, under the sessionWorkouts rule
    for who appears. Sessions the viewer may not open, or with no workout, are
    left out.
    """
    sessionWorkoutHeadlines(sessionIds: [ID!]!): [SessionWorkoutHeadline!]!
  }

  extend type Mutation {
    """
    Store the caller's workout for a session. Written only when revision is
    higher than the stored one; an equal or lower revision is a no-op that still
    returns true, so outbox replays are idempotent. The caller must have created
    or joined the session. Tick-map entries that are not the caller's own ticks
    in the session are dropped.
    """
    recordSessionWorkout(input: RecordSessionWorkoutInput!): Boolean!
  }
`;
