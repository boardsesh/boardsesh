import type { ConnectionContext } from '@boardsesh/shared-schema';
import { withRegistration } from './partner-registration';
import {
  enqueueOwnedWebhookTest,
  readOwnedWebhook,
  readOwnedWebhookDeliveries,
  rotateOwnedWebhookSecret,
  updateOwnedWebhook,
} from '../../../services/partner-webhooks/settings';

export const partnerWebhookQueries = {
  partnerWebhookSettings: (_: unknown, { clientId }: { clientId: string }, context: ConnectionContext) =>
    withRegistration(context, 'read', (_registration, developerId, database) =>
      readOwnedWebhook(database, developerId, clientId),
    ),
  partnerWebhookDeliveries: (_: unknown, { clientId }: { clientId: string }, context: ConnectionContext) =>
    withRegistration(context, 'read', (_registration, developerId, database) =>
      readOwnedWebhookDeliveries(database, developerId, clientId),
    ),
};
export const partnerWebhookMutations = {
  updatePartnerWebhook: (_: unknown, { input }: { input: unknown }, context: ConnectionContext) =>
    withRegistration(context, 'write', (_registration, developerId, database) =>
      updateOwnedWebhook(database, developerId, input, context.webSignIn),
    ),
  rotatePartnerWebhookSecret: (_: unknown, { clientId }: { clientId: string }, context: ConnectionContext) =>
    withRegistration(context, 'write', (_registration, developerId, database) =>
      rotateOwnedWebhookSecret(database, developerId, clientId, context.webSignIn),
    ),
  testPartnerWebhook: (_: unknown, { clientId }: { clientId: string }, context: ConnectionContext) =>
    withRegistration(context, 'write', (_registration, developerId, database) =>
      enqueueOwnedWebhookTest(database, developerId, clientId),
    ),
};
