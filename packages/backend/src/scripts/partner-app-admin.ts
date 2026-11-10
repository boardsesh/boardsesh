/**
 * Partner OAuth admin commands. Each acts on exactly the one id you name, and
 * reports what it would do without writing anything unless you add --apply.
 *
 *   vp exec tsx packages/backend/src/scripts/partner-app-admin.ts suspend --client-id <id> --reason "<shown to the developer>"
 *   vp exec tsx packages/backend/src/scripts/partner-app-admin.ts unsuspend --client-id <id>
 *   vp exec tsx packages/backend/src/scripts/partner-app-admin.ts revoke-user --user-id <id>
 *   vp exec tsx packages/backend/src/scripts/partner-app-admin.ts set-publisher --client-id <id> --publisher "<shown to climbers>"
 *
 * suspend      Sets `oauth_client.disabled`, which the provider checks on every
 *              authorize, token and revoke call, and records when and why on
 *              the app's policy row. Tokens stay in place, so unsuspend brings
 *              the app back. Other backend instances stop answering its browser
 *              origins within the 60 s origin cache.
 * unsuspend    Clears both again.
 * revoke-user  Ends every partner connection a climber has, through
 *              public.partner_revoke_user(): generations bumped, connections
 *              revoked, and every token, consent, ancestor, pending code, grant,
 *              consent screen and partner session deleted. The climber's own
 *              first-party sign-ins are untouched.
 * set-publisher Sets the "Made by" name the consent screen shows, under the
 *              same rules registration applies: an app registered before
 *              publishers were recorded, or one whose publisher must be
 *              corrected. Works on a suspended app too.
 *
 * Connects with DATABASE_URL. partner_revoke_user is SECURITY INVOKER, so the
 * login needs UPDATE on users (it locks the climber's row FOR NO KEY UPDATE) and
 * SELECT, UPDATE and DELETE on the oauth_ tables. In production that is the
 * backend service's own login, boardsesh_runtime, which the migration runner's
 * ACL reconcile grants DML on every table and EXECUTE on every routine. Every
 * transaction here asks for READ COMMITTED itself, whatever the role's default,
 * because the function refuses any other isolation.
 */
import { pathToFileURL } from 'node:url';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { closePool, executeFirstRow } from '@boardsesh/db/client';
import {
  oauthAccessToken,
  oauthAppPolicy,
  oauthClient,
  oauthConnections,
  oauthConsent,
  oauthConsentInteractions,
  oauthGrants,
  oauthRefreshAncestors,
  oauthRefreshToken,
  oauthSession,
  oauthVerification,
  users,
} from '@boardsesh/db/schema/auth';
import { PartnerRegistrationError, validatePartnerPublisherName } from '../auth/partner/registration-rules';
import { db, type Database } from '../db/client';
import { getPostgresErrorCode } from '../utils/postgres-errors';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type PartnerAdminDatabase = Pick<Database, 'transaction'>;

const MAX_REASON_LENGTH = 500;
const MAX_ID_LENGTH = 128;
const LOCK_TIMEOUT = '5s';
const STATEMENT_TIMEOUT = '30s';

export const PARTNER_ADMIN_USAGE = `Usage:
  partner-app-admin.ts suspend --client-id <id> --reason "<text the developer sees>" [--apply]
  partner-app-admin.ts unsuspend --client-id <id> [--apply]
  partner-app-admin.ts revoke-user --user-id <id> [--apply]
  partner-app-admin.ts set-publisher --client-id <id> --publisher "<text climbers see>" [--apply]
Without --apply nothing is written.`;

export class PartnerAdminUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PartnerAdminUsageError';
  }
}

export type PartnerAdminCommand =
  | { command: 'suspend'; clientId: string; reason: string; apply: boolean }
  | { command: 'unsuspend'; clientId: string; apply: boolean }
  | { command: 'revoke-user'; userId: string; apply: boolean }
  | { command: 'set-publisher'; clientId: string; publisherName: string; apply: boolean };

const FLAGS_BY_COMMAND = {
  suspend: ['--client-id', '--reason'],
  unsuspend: ['--client-id'],
  'revoke-user': ['--user-id'],
  'set-publisher': ['--client-id', '--publisher'],
} as const;

const COMMANDS = Object.keys(FLAGS_BY_COMMAND) as ReadonlyArray<keyof typeof FLAGS_BY_COMMAND>;

function isCommand(candidate: string | undefined): candidate is keyof typeof FLAGS_BY_COMMAND {
  return COMMANDS.some((command) => command === candidate);
}

function singleId(value: string, flag: string): string {
  if (value.length === 0 || value.length > MAX_ID_LENGTH || /[\s,*%]/.test(value)) {
    throw new PartnerAdminUsageError(`${flag} takes exactly one id, with no spaces, commas or wildcards.`);
  }
  return value;
}

/** Every value must be given explicitly: no defaults, no lists, no repeated flags. */
export function parsePartnerAdminArguments(argv: readonly string[]): PartnerAdminCommand {
  const [command, ...rest] = argv;
  if (!isCommand(command)) {
    throw new PartnerAdminUsageError(`Unknown command ${JSON.stringify(command ?? '')}.`);
  }
  const allowed: readonly string[] = FLAGS_BY_COMMAND[command];
  const values = new Map<string, string>();
  let apply = false;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === '--apply') {
      if (apply) throw new PartnerAdminUsageError('--apply is given twice.');
      apply = true;
      continue;
    }
    if (!allowed.includes(flag)) throw new PartnerAdminUsageError(`${command} does not take ${flag}.`);
    if (values.has(flag)) throw new PartnerAdminUsageError(`${flag} is given twice.`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) throw new PartnerAdminUsageError(`${flag} needs a value.`);
    values.set(flag, value);
    index += 1;
  }
  for (const flag of allowed) {
    if (!values.has(flag)) throw new PartnerAdminUsageError(`${command} needs ${flag}.`);
  }
  if (command === 'revoke-user') {
    return { command, userId: singleId(values.get('--user-id') as string, '--user-id'), apply };
  }
  const clientId = singleId(values.get('--client-id') as string, '--client-id');
  if (command === 'unsuspend') return { command, clientId, apply };
  if (command === 'set-publisher') {
    try {
      return { command, clientId, publisherName: validatePartnerPublisherName(values.get('--publisher')), apply };
    } catch (error) {
      if (error instanceof PartnerRegistrationError) throw new PartnerAdminUsageError(`--publisher: ${error.message}`);
      throw error;
    }
  }
  const reason = (values.get('--reason') as string).trim();
  if (reason.length === 0 || reason.length > MAX_REASON_LENGTH) {
    throw new PartnerAdminUsageError(`--reason must be 1 to ${MAX_REASON_LENGTH} characters; the developer sees it.`);
  }
  return { command, clientId, reason, apply };
}

/** READ COMMITTED always, and read-only for a dry run, so a dry run cannot write. */
function inAdminTransaction<Result>(
  database: PartnerAdminDatabase,
  apply: boolean,
  work: (transaction: Transaction) => Promise<Result>,
): Promise<Result> {
  return database.transaction(
    async (transaction) => {
      await transaction.execute(
        sql`select set_config('lock_timeout', ${LOCK_TIMEOUT}, true),
                   set_config('statement_timeout', ${STATEMENT_TIMEOUT}, true)`,
      );
      return work(transaction);
    },
    { isolationLevel: 'read committed', accessMode: apply ? 'read write' : 'read only' },
  );
}

export interface PartnerAppState {
  disabled: boolean;
  suspendedAt: string | null;
  suspensionReason: string | null;
}

export interface PartnerAppAdminReport {
  command: 'suspend' | 'unsuspend';
  applied: boolean;
  clientId: string;
  name: string | null;
  ownerUserId: string | null;
  liveConnections: number;
  before: PartnerAppState;
  /** The state after --apply, or the state --apply would leave. */
  after: PartnerAppState;
  /** False when the app was already in the requested state, so nothing would change. */
  changes: boolean;
}

async function readApp(transaction: Transaction, clientId: string) {
  const [found] = await transaction
    .select({ app: oauthClient, policy: oauthAppPolicy })
    .from(oauthClient)
    .leftJoin(oauthAppPolicy, eq(oauthAppPolicy.clientId, oauthClient.clientId))
    .where(eq(oauthClient.clientId, clientId));
  if (!found) throw new PartnerAdminUsageError(`No app has client id ${clientId}.`);
  const liveConnections = await transaction.$count(
    oauthConnections,
    and(eq(oauthConnections.clientId, clientId), isNull(oauthConnections.revokedAt)),
  );
  const state: PartnerAppState = {
    disabled: found.app.disabled === true,
    suspendedAt: found.policy?.suspendedAt?.toISOString() ?? null,
    suspensionReason: found.policy?.suspensionReason ?? null,
  };
  return { ...found, liveConnections, state };
}

/**
 * Suspends one app. `disabled` is what stops it: the provider refuses a
 * disabled client at authorize, token and revoke, and registered origins drop
 * it. `suspended_at` and the reason are what the developer and Connected apps see.
 */
export async function suspendPartnerApp(
  database: PartnerAdminDatabase,
  { clientId, reason, apply }: { clientId: string; reason: string; apply: boolean },
): Promise<PartnerAppAdminReport> {
  return inAdminTransaction(database, apply, async (transaction) => {
    const { app, policy, liveConnections, state } = await readApp(transaction, clientId);
    const now = new Date();
    const after: PartnerAppState = {
      disabled: true,
      suspendedAt: state.suspendedAt ?? now.toISOString(),
      suspensionReason: reason,
    };
    const changes = !state.disabled || !state.suspendedAt || state.suspensionReason !== reason;
    if (apply && changes) {
      await transaction
        .update(oauthClient)
        .set({ disabled: true, updatedAt: now })
        .where(eq(oauthClient.clientId, clientId));
      const ownerUserId = policy?.ownerUserId ?? app.userId;
      // The first suspension's time stays; a later run only changes the reason.
      const suspendedAt = policy?.suspendedAt ?? now;
      if (ownerUserId) {
        await transaction
          .insert(oauthAppPolicy)
          .values({ clientId, ownerUserId, suspendedAt, suspensionReason: reason, updatedAt: now })
          .onConflictDoUpdate({
            target: oauthAppPolicy.clientId,
            set: { suspendedAt, suspensionReason: reason, updatedAt: now },
          });
      }
    }
    return {
      command: 'suspend',
      applied: apply && changes,
      clientId,
      name: app.name,
      ownerUserId: policy?.ownerUserId ?? app.userId,
      liveConnections,
      before: state,
      after,
      changes,
    };
  });
}

export async function unsuspendPartnerApp(
  database: PartnerAdminDatabase,
  { clientId, apply }: { clientId: string; apply: boolean },
): Promise<PartnerAppAdminReport> {
  return inAdminTransaction(database, apply, async (transaction) => {
    const { app, policy, liveConnections, state } = await readApp(transaction, clientId);
    const changes = state.disabled || state.suspendedAt !== null || state.suspensionReason !== null;
    if (apply && changes) {
      const now = new Date();
      await transaction
        .update(oauthClient)
        .set({ disabled: false, updatedAt: now })
        .where(eq(oauthClient.clientId, clientId));
      await transaction
        .update(oauthAppPolicy)
        .set({ suspendedAt: null, suspensionReason: null, updatedAt: now })
        .where(eq(oauthAppPolicy.clientId, clientId));
    }
    return {
      command: 'unsuspend',
      applied: apply && changes,
      clientId,
      name: app.name,
      ownerUserId: policy?.ownerUserId ?? app.userId,
      liveConnections,
      before: state,
      after: { disabled: false, suspendedAt: null, suspensionReason: null },
      changes,
    };
  });
}

export interface PartnerUserRows {
  liveConnections: number;
  accessTokens: number;
  refreshTokens: number;
  consents: number;
  refreshAncestors: number;
  consentScreens: number;
  partnerSessions: number;
  grants: number;
  pendingCodes: number;
}

export interface PartnerUserRevocationReport {
  command: 'revoke-user';
  applied: boolean;
  userId: string;
  before: PartnerUserRows;
  /** Null on a dry run. */
  after: PartnerUserRows | null;
  /** What partner_revoke_user returned: connection rows it bumped. Null on a dry run. */
  connectionsRevoked: number | null;
}

async function countPartnerUserRows(transaction: Transaction, userId: string): Promise<PartnerUserRows> {
  const connectionIds = (
    await transaction
      .select({ id: oauthConnections.id })
      .from(oauthConnections)
      .where(eq(oauthConnections.userId, userId))
  ).map((connection) => connection.id);
  const codeIds =
    connectionIds.length === 0
      ? []
      : (
          await transaction
            .select({ id: oauthGrants.authorizationCodeId })
            .from(oauthGrants)
            .where(inArray(oauthGrants.connectionId, connectionIds))
        ).map((grant) => grant.id);
  return {
    liveConnections: await transaction.$count(
      oauthConnections,
      and(eq(oauthConnections.userId, userId), isNull(oauthConnections.revokedAt)),
    ),
    accessTokens: await transaction.$count(oauthAccessToken, eq(oauthAccessToken.userId, userId)),
    refreshTokens: await transaction.$count(oauthRefreshToken, eq(oauthRefreshToken.userId, userId)),
    consents: await transaction.$count(oauthConsent, eq(oauthConsent.userId, userId)),
    refreshAncestors: await transaction.$count(oauthRefreshAncestors, eq(oauthRefreshAncestors.userId, userId)),
    consentScreens: await transaction.$count(oauthConsentInteractions, eq(oauthConsentInteractions.userId, userId)),
    partnerSessions: await transaction.$count(oauthSession, eq(oauthSession.userId, userId)),
    grants: codeIds.length,
    pendingCodes:
      codeIds.length === 0
        ? 0
        : await transaction.$count(oauthVerification, inArray(oauthVerification.identifier, codeIds)),
  };
}

/**
 * Account-wide partner revocation for one climber, the explicit admin row of
 * the fast path's revocation table. The same function the password trigger calls.
 */
export async function revokePartnerUser(
  database: PartnerAdminDatabase,
  { userId, apply }: { userId: string; apply: boolean },
): Promise<PartnerUserRevocationReport> {
  return inAdminTransaction(database, apply, async (transaction) => {
    const [climber] = await transaction.select({ id: users.id }).from(users).where(eq(users.id, userId));
    if (!climber) throw new PartnerAdminUsageError(`No account has id ${userId}.`);
    const before = await countPartnerUserRows(transaction, userId);
    if (!apply)
      return { command: 'revoke-user', applied: false, userId, before, after: null, connectionsRevoked: null };
    const result = await executeFirstRow<{ revoked: number }>(
      transaction,
      sql`select public.partner_revoke_user(${userId}) as revoked`,
    );
    return {
      command: 'revoke-user',
      applied: true,
      userId,
      before,
      after: await countPartnerUserRows(transaction, userId),
      connectionsRevoked: result?.revoked ?? 0,
    };
  });
}

export interface PartnerPublisherReport {
  command: 'set-publisher';
  applied: boolean;
  clientId: string;
  name: string | null;
  before: string | null;
  /** The publisher after --apply, or the one --apply would write. */
  after: string;
  /** False when the app already has this publisher. */
  changes: boolean;
}

/**
 * Sets the "Made by" name on one app's policy row. An app with no policy row is
 * refused rather than given one: without a policy row it can gain no connections,
 * and naming its publisher must not change that.
 */
export async function setPartnerAppPublisher(
  database: PartnerAdminDatabase,
  { clientId, publisherName, apply }: { clientId: string; publisherName: string; apply: boolean },
): Promise<PartnerPublisherReport> {
  return inAdminTransaction(database, apply, async (transaction) => {
    const { app, policy } = await readApp(transaction, clientId);
    if (!policy) throw new PartnerAdminUsageError(`App ${clientId} has no policy row, so it has no publisher to set.`);
    const changes = policy.publisherName !== publisherName;
    if (apply && changes) {
      await transaction
        .update(oauthAppPolicy)
        .set({ publisherName, updatedAt: new Date() })
        .where(eq(oauthAppPolicy.clientId, clientId));
    }
    return {
      command: 'set-publisher',
      applied: apply && changes,
      clientId,
      name: app.name,
      before: policy.publisherName,
      after: publisherName,
      changes,
    };
  });
}

export function runPartnerAdminCommand(database: PartnerAdminDatabase, command: PartnerAdminCommand) {
  if (command.command === 'suspend') return suspendPartnerApp(database, command);
  if (command.command === 'unsuspend') return unsuspendPartnerApp(database, command);
  if (command.command === 'set-publisher') return setPartnerAppPublisher(database, command);
  return revokePartnerUser(database, command);
}

async function main(): Promise<void> {
  let command: PartnerAdminCommand;
  try {
    command = parsePartnerAdminArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${PARTNER_ADMIN_USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    const report = await runPartnerAdminCommand(db, command);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!command.apply) process.stdout.write('Dry run: nothing was written. Add --apply to write.\n');
  } catch (error) {
    // A query error's text carries its parameters: name and database code only.
    const message =
      error instanceof PartnerAdminUsageError
        ? error.message
        : `${error instanceof Error ? error.name : 'Error'} (database code ${getPostgresErrorCode(error) ?? 'none'})`;
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
