import { randomBytes } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { WebSignInProof } from '@boardsesh/shared-schema';
import type {
  PartnerWebhookCredentials,
  PartnerWebhookDelivery,
  PartnerWebhookSettings,
} from '@boardsesh/shared-schema';
import { oauthAppPolicy, oauthClient } from '@boardsesh/db/schema/auth';
import { oauthClientWebhooks, partnerWebhookOutbox, webhookDeliveries } from '@boardsesh/db/schema/app';
import { lockDeveloper, requireRecentSignIn } from '../../auth/partner/developer-change';
import { PartnerRegistrationError } from '../../auth/partner/registration-rules';
import { runInPartnerTransaction } from '../../auth/partner/transaction';
import type { PartnerDatabase } from '../../auth/partner/tables';
import { decryptWebhookSecret, encryptWebhookSecret } from './crypto';
import { PARTNER_WEBHOOK_EVENTS } from './events';
import { resolveWebhookTarget, UnsafeWebhookUrlError } from './transport';

const InputSchema = z.object({
  clientId: z.string().min(1).max(128),
  url: z.string().min(1).max(2048),
  events: z
    .array(z.enum(PARTNER_WEBHOOK_EVENTS))
    .min(1)
    .max(3)
    .transform((events) => [...new Set(events)]),
  enabled: z.boolean(),
});
type SettingsRow = typeof oauthClientWebhooks.$inferSelect;

export function presentWebhookSettings(settings: SettingsRow): PartnerWebhookSettings {
  return {
    clientId: settings.clientId,
    url: settings.url,
    events: settings.events,
    enabled: settings.enabled,
    disabledReason: settings.disabledReason,
    previousSecretExpiresAt: settings.previousSecretExpiresAt?.toISOString() ?? null,
  };
}

async function requireOwnedApp(database: PartnerDatabase, developerId: string, clientId: string): Promise<void> {
  const [app] = await database
    .select({ disabled: oauthClient.disabled })
    .from(oauthAppPolicy)
    .innerJoin(oauthClient, eq(oauthClient.clientId, oauthAppPolicy.clientId))
    .where(and(eq(oauthAppPolicy.clientId, clientId), eq(oauthAppPolicy.ownerUserId, developerId)));
  if (!app) throw new PartnerRegistrationError('not_found', 'No app with that client ID.');
  if (app.disabled) throw new PartnerRegistrationError('suspended', 'This app is suspended.');
}

export async function readOwnedWebhook(
  database: PartnerDatabase,
  developerId: string,
  clientId: string,
): Promise<PartnerWebhookSettings | null> {
  await requireOwnedApp(database, developerId, clientId);
  const [settings] = await database
    .select()
    .from(oauthClientWebhooks)
    .where(eq(oauthClientWebhooks.clientId, clientId));
  return settings ? presentWebhookSettings(settings) : null;
}

export async function readOwnedWebhookDeliveries(
  database: PartnerDatabase,
  developerId: string,
  clientId: string,
): Promise<PartnerWebhookDelivery[]> {
  await requireOwnedApp(database, developerId, clientId);
  const deliveries = await database
    .select({
      id: webhookDeliveries.id,
      event: webhookDeliveries.event,
      status: webhookDeliveries.status,
      attempts: webhookDeliveries.attempts,
      lastStatusCode: webhookDeliveries.lastStatusCode,
      lastError: webhookDeliveries.lastError,
      createdAt: webhookDeliveries.createdAt,
      deliveredAt: webhookDeliveries.deliveredAt,
    })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.clientId, clientId))
    .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
    .limit(20);
  return deliveries.map((delivery) => ({
    ...delivery,
    createdAt: delivery.createdAt.toISOString(),
    deliveredAt: delivery.deliveredAt?.toISOString() ?? null,
  }));
}

async function lockWebhookOwner(
  database: PartnerDatabase,
  developerId: string,
  clientId: string,
  signIn: WebSignInProof | null | undefined,
): Promise<void> {
  await lockDeveloper(database, developerId);
  await requireOwnedApp(database, developerId, clientId);
  await requireRecentSignIn(database, developerId, signIn);
}

export async function updateOwnedWebhook(
  database: PartnerDatabase,
  developerId: string,
  input: unknown,
  signIn?: WebSignInProof | null,
): Promise<PartnerWebhookCredentials> {
  const parsed = InputSchema.safeParse(input);
  if (!parsed.success)
    throw new PartnerRegistrationError('invalid_input', 'Choose a public HTTPS URL and at least one supported event.');
  const spec = parsed.data;
  await requireOwnedApp(database, developerId, spec.clientId);
  const [previous] = await database
    .select({ url: oauthClientWebhooks.url })
    .from(oauthClientWebhooks)
    .where(eq(oauthClientWebhooks.clientId, spec.clientId));
  try {
    // An unreachable endpoint must never stop its owner disabling it.
    if (spec.enabled || previous?.url !== spec.url) await resolveWebhookTarget(spec.url);
  } catch (error) {
    if (error instanceof UnsafeWebhookUrlError) throw new PartnerRegistrationError('invalid_input', error.message);
    throw new PartnerRegistrationError('busy', 'Webhook DNS is unavailable. Try again shortly.');
  }
  return runInPartnerTransaction(database, async (transaction) => {
    await lockWebhookOwner(transaction, developerId, spec.clientId, signIn);
    const [existing] = await transaction
      .select()
      .from(oauthClientWebhooks)
      .where(eq(oauthClientWebhooks.clientId, spec.clientId))
      .for('update');
    if (
      existing &&
      existing.url === spec.url &&
      existing.enabled === spec.enabled &&
      [...existing.events].sort().join('\0') === [...spec.events].sort().join('\0')
    ) {
      return { settings: presentWebhookSettings(existing), secret: null };
    }
    const secret = existing ? null : randomBytes(32).toString('base64url');
    const updated = {
      url: spec.url,
      events: spec.events,
      enabled: spec.enabled,
      updatedAt: new Date(),
      disabledReason: null,
      failingSince: null,
      lastFailureAt: null,
      failureEmailPending: false,
      version: (existing?.version ?? 0) + 1,
    };
    const [settings] = await transaction
      .insert(oauthClientWebhooks)
      .values({
        clientId: spec.clientId,
        ...updated,
        secret: existing?.secret ?? encryptWebhookSecret(secret!),
      })
      .onConflictDoUpdate({ target: oauthClientWebhooks.clientId, set: updated })
      .returning();
    // Old endpoint generations must never receive events after an edit or re-enable.
    await transaction
      .update(webhookDeliveries)
      .set({ status: 'cancelled', lastError: 'endpoint_changed', settledAt: new Date() })
      .where(
        and(eq(webhookDeliveries.clientId, spec.clientId), inArray(webhookDeliveries.status, ['pending', 'retrying'])),
      );
    return { settings: presentWebhookSettings(settings), secret };
  });
}

export async function rotateOwnedWebhookSecret(
  database: PartnerDatabase,
  developerId: string,
  clientId: string,
  signIn?: WebSignInProof | null,
): Promise<PartnerWebhookCredentials> {
  return runInPartnerTransaction(database, async (transaction) => {
    await lockWebhookOwner(transaction, developerId, clientId, signIn);
    const [existing] = await transaction
      .select()
      .from(oauthClientWebhooks)
      .where(eq(oauthClientWebhooks.clientId, clientId))
      .for('update');
    if (!existing) throw new PartnerRegistrationError('not_found', 'Configure a webhook first.');
    let previousSecret: string | null = null;
    try {
      previousSecret = encryptWebhookSecret(decryptWebhookSecret(existing.secret));
    } catch {
      // Owners can recover immediately when a retired sealing key is unavailable.
    }
    if (previousSecret && existing.previousSecretExpiresAt && existing.previousSecretExpiresAt.getTime() > Date.now()) {
      throw new PartnerRegistrationError(
        'invalid_input',
        `The previous signing secret remains valid until ${existing.previousSecretExpiresAt.toISOString()}. Rotate again after that time.`,
      );
    }
    const secret = randomBytes(32).toString('base64url');
    const [settings] = await transaction
      .update(oauthClientWebhooks)
      .set({
        secret: encryptWebhookSecret(secret),
        previousSecret,
        previousSecretExpiresAt: previousSecret ? new Date(Date.now() + 24 * 60 * 60 * 1000) : null,
        updatedAt: new Date(),
      })
      .where(eq(oauthClientWebhooks.clientId, clientId))
      .returning();
    return { settings: presentWebhookSettings(settings), secret };
  });
}

export async function enqueueOwnedWebhookTest(
  database: PartnerDatabase,
  developerId: string,
  clientId: string,
): Promise<string> {
  return runInPartnerTransaction(database, async (transaction) => {
    await lockDeveloper(transaction, developerId);
    await requireOwnedApp(transaction, developerId, clientId);
    const [settings] = await transaction
      .select({ enabled: oauthClientWebhooks.enabled, version: oauthClientWebhooks.version })
      .from(oauthClientWebhooks)
      .where(eq(oauthClientWebhooks.clientId, clientId));
    if (!settings?.enabled) throw new PartnerRegistrationError('invalid_input', 'Enable a webhook first.');
    const [event] = await transaction
      .insert(partnerWebhookOutbox)
      .values({
        clientId,
        connectionId: 'test',
        connectionGeneration: 0,
        type: 'webhook.test',
        subject: 'usr_test',
        endpointVersion: settings.version,
      })
      .returning({ id: partnerWebhookOutbox.id });
    return event.id;
  });
}
