export const appWorkoutsTypeDefs = /* GraphQL */ `
  "A partner workout delivered to the signed-in climber. Its session identifier never leaves the partner API."
  type AppWorkout {
    id: ID!
    clientId: ID!
    status: String!
    title: String!
    sourceAppName: String!
    sessionId: ID
    sessionPlan: JSON
    notes: String
    scheduledFor: String
    spec: JSON!
    blocks: JSON!
    expiresAt: String!
    openedByMismatch: Boolean!
  }
  type AppWorkoutLaunch {
    sourceAppName: String!
  }
  extend type Query {
    appWorkout(id: ID!): AppWorkout!
    "Only the registered app's public name; never the workout title, notes or blocks."
    publicAppWorkoutLaunch(id: ID!): AppWorkoutLaunch
  }
  extend type Mutation {
    attachAppWorkout(workoutId: ID!, sessionId: ID!): Boolean!
    recordAppWorkoutPlan(workoutId: ID!, plan: JSON!): Boolean!
  }
`;
