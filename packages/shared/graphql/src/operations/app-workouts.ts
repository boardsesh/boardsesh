import { gql } from 'graphql-request';

export const GET_APP_WORKOUT = gql`
  query AppWorkout($id: ID!) {
    appWorkout(id: $id) {
      id
      clientId
      status
      title
      sourceAppName
      notes
      spec
      expiresAt
      sessionId
      sessionPlan
    }
  }
`;
export const ATTACH_APP_WORKOUT = gql`
  mutation AttachAppWorkout($workoutId: ID!, $sessionId: ID!) {
    attachAppWorkout(workoutId: $workoutId, sessionId: $sessionId)
  }
`;
export const RECORD_APP_WORKOUT_PLAN = gql`
  mutation RecordAppWorkoutPlan($workoutId: ID!, $plan: JSON!) {
    recordAppWorkoutPlan(workoutId: $workoutId, plan: $plan)
  }
`;
