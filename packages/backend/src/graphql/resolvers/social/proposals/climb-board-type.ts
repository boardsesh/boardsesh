import { GraphQLError } from 'graphql';

/** Guard client-declared proposal scope against the climb's stored board. */
export function assertClimbBoardType(storedBoardType: string, requestedBoardType: string): void {
  if (storedBoardType === requestedBoardType) return;
  throw new GraphQLError('Board type does not match climb', {
    extensions: { code: 'BAD_USER_INPUT' },
  });
}
