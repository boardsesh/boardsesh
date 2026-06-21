import { z } from 'zod';
import { SessionIdSchema } from './primitives';

/** GraphQL IntegrationProvider enum values. */
export const IntegrationProviderSchema = z.enum(['STRAVA']);

/** Mutations whose only argument is the provider (disconnect, OAuth handoff). */
export const IntegrationProviderArgsSchema = z.object({
  provider: IntegrationProviderSchema,
});

export const DisconnectIntegrationSchema = IntegrationProviderArgsSchema;

export const SetIntegrationAutoSyncSchema = z.object({
  provider: IntegrationProviderSchema,
  enabled: z.boolean(),
});

export const SyncSessionToIntegrationSchema = z.object({
  provider: IntegrationProviderSchema,
  sessionId: SessionIdSchema,
});
