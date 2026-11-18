import { GraphQLError } from 'graphql';
import { AppWorkoutError } from '../../../services/public-api/workouts';

export function appWorkoutGraphError(error: AppWorkoutError): GraphQLError {
  return new GraphQLError(error.message, {
    extensions: {
      code: error.status === 404 ? 'NOT_FOUND' : error.status === 409 ? 'CONFLICT' : 'BAD_USER_INPUT',
      ...(error.reason ? { reason: error.reason } : {}),
    },
  });
}
