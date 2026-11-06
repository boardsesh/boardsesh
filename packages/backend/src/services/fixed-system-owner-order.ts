import { GraphQLError } from 'graphql';
import {
  captureFixedSystemOwnerOrderMode as captureDatabaseOrderMode,
  lockCooperativeFixedSystemOwnerTransaction as lockDatabaseContentTransaction,
  FixedSystemOwnerOrderError,
  type FixedSystemOwnerOrderMode,
  type FixedSystemOwnerTransaction,
} from '@boardsesh/db/fixed-system-owner-order';

function rethrowOrderFailure(error: unknown): never {
  if (error instanceof FixedSystemOwnerOrderError) {
    throw new GraphQLError('That update is temporarily unavailable. Try again.', {
      extensions: { code: 'SERVICE_UNAVAILABLE', http: { status: 503 } },
    });
  }
  throw error;
}

/** GraphQL boundary only; configuration and contention never become authentication failures. */
export function captureFixedSystemOwnerOrderMode(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): FixedSystemOwnerOrderMode {
  try {
    return captureDatabaseOrderMode(environment);
  } catch (error) {
    return rethrowOrderFailure(error);
  }
}

export async function lockCooperativeFixedSystemOwnerTransaction(
  transaction: FixedSystemOwnerTransaction,
  mode: FixedSystemOwnerOrderMode,
): Promise<void> {
  try {
    await lockDatabaseContentTransaction(transaction, mode);
  } catch (error) {
    rethrowOrderFailure(error);
  }
}
