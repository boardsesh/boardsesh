import { GraphQLError } from 'graphql';

/** New CNC work is closed until the deployment explicitly selects a release mode. */
export function isCncCreationAllowed(userId: string): boolean {
  const mode = process.env.CNC_RELEASE_MODE;
  // Existing HTTP deployments keep their previous behavior until they opt in.
  if (mode === undefined && process.env.CNC_TRANSPORT !== 'pgboss') return true;
  if (mode === 'public') return true;
  if (mode !== 'beta' || !userId || userId.trim() !== userId) return false;

  // These are immutable account IDs, never email addresses or PostHog identities.
  const allowedIds = (process.env.CNC_BETA_USER_IDS ?? '').split(',').map((entry) => entry.trim());
  if (allowedIds.some((entry) => !/^[A-Za-z0-9_-]{1,128}$/.test(entry))) return false;
  return allowedIds.includes(userId);
}

export function requireCncCreationAccess(userId: string): void {
  if (!isCncCreationAllowed(userId)) {
    throw new GraphQLError('The build-pack service is unavailable right now. Try again in a minute.', {
      extensions: { code: 'CNC_WORKER_UNAVAILABLE' },
    });
  }
}

export function requireCncCheckoutAccess(userId: string): void {
  if (!isCncCreationAllowed(userId)) {
    throw new GraphQLError('Build-pack generation is unavailable right now. Try again in a minute.', {
      extensions: { code: 'CNC_CHECKOUT_UNAVAILABLE' },
    });
  }
}
