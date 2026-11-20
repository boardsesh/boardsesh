import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { hash } from 'bcryptjs';
import { authCredentialLineage, authEmailProjection, authSession, users } from '@boardsesh/db/schema/auth';
import type { ProviderSecurityActor, ProviderSecurityProvider } from '@boardsesh/auth-protocol';
import { createEnvironment } from './environment';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../current-store/foundation-context';
import { prepareProjectionUnderUsersTableLock } from '../../current-store/email-reservations';
import { captureIdentityAuthority, switchIdentityAuthority, type IdentityAuthorityName } from '../router';
import { bindIdentityAuthority } from '../identity-authority';
import type { AuthorityDatabase } from '../adapter';
import {
  bindProviderSecurityFlow,
  createProviderSecurityIntent,
  type ProviderSecurityRuntime,
} from '../provider-security-intents';
import { reauthenticateProviderWithPassword } from '../provider-security-reauthentication';
import { prepareProviderSecurityMutation } from '../provider-security-finalizer';
import { sessionTokenDigest } from '../session-token';
import { CARRIED_WEB_SESSION_LINEAGE_PREFIX } from '../web-session';

const requireWeb = createRequire(new URL('../../../../../web/package.json', import.meta.url));
const jwt = requireWeb('next-auth/jwt') as {
  encode(input: { secret: string; token: Record<string, unknown>; maxAge: number }): Promise<string>;
};
export const encodeLegacyTestCredential = jwt.encode;

export async function createProviderSecurityEnvironment() {
  const environment = await createEnvironment();
  try {
    for (const filename of ['0312_browser_binding_selection.sql', '0313_provider_security_receipts.sql'])
      await environment.client.unsafe(
        readFileSync(new URL(`../../../../../db/drizzle/${filename}`, import.meta.url), 'utf8'),
      );
    const qualification = {
      expectedProjectionId: randomUUID(),
      expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
    };
    await environment.database.transaction(async (transaction) => {
      await prepareProjectionUnderUsersTableLock(transaction, { projectionId: qualification.expectedProjectionId });
      await transaction.update(authEmailProjection).set({ phase: 'enforced' });
    });
    const secret = 'provider-finalization-owned-cookie-secret';
    const runtime: ProviderSecurityRuntime = {
      qualification,
      legacySecret: secret,
      methods: {
        configuredProviders: ['google', 'apple'],
        googleAudience: 'owned-google-client',
        googleReauthenticationEnabled: true,
      },
    };
    return { ...environment, ...(await createProviderSecurityDriver({ database: environment.database, runtime })) };
  } catch (error) {
    await environment.close();
    throw error;
  }
}

/** Existing owned canonical schema/manifest and an already-qualified database only; no DDL or cleanup. */
export async function createProviderSecurityDriver(input: {
  readonly database: AuthorityDatabase;
  readonly runtime: ProviderSecurityRuntime;
  readonly passwordHash?: string;
}) {
  const environment = { database: input.database };
  const runtime = {
    ...input.runtime,
    qualification: { ...input.runtime.qualification },
    methods: { ...input.runtime.methods, configuredProviders: [...input.runtime.methods.configuredProviders] },
  };
  const qualification = runtime.qualification;
  const secret = (() => {
    const configured = runtime.legacySecret;
    if (!configured) throw new Error('Owned provider fixture issuer key required');
    return configured;
  })();
  const suppliedPasswordHash = input.passwordHash;
  const passwordHash = suppliedPasswordHash ?? (await hash(' exact password ', 4));
  async function selectAuthority(selected: IdentityAuthorityName) {
    await environment.database.transaction(async (transaction) => {
      const [manifest] = await transaction.select().from(authEmailProjection);
      if (manifest.writerAuthority !== selected)
        await switchIdentityAuthority(transaction, {
          projectionId: qualification.expectedProjectionId,
          epoch: manifest.writerEpoch,
          from: manifest.writerAuthority,
          to: selected,
        });
    });
  }
  async function actor(
    selected: IdentityAuthorityName,
    kind: 'legacy-jwe' | 'canonical-token',
    options: {
      readonly password?: boolean;
      readonly provider?: ProviderSecurityProvider;
      readonly subject?: string;
      readonly unknownAge?: boolean;
      /** A canonical row's source: `login` (no lineage, the default), `bridge` (a live lineage) or `carried`. */
      readonly source?: 'login' | 'bridge' | 'carried';
      /** Seconds since the sign-in. Defaults to a day. */
      readonly signedInSecondsAgo?: number;
    } = {},
  ) {
    await selectAuthority(selected);
    const userId = randomUUID();
    const sid = randomUUID();
    const authenticatedAt = options.unknownAge
      ? null
      : new Date(Math.floor(Date.now() / 1000) * 1000 - (options.signedInSecondsAgo ?? 86_400) * 1000);
    await environment.database
      .insert(users)
      .values({ id: userId, email: `provider-final-${userId}@example.test`, name: null });
    await environment.database.transaction(async (transaction) => {
      const identity = bindIdentityAuthority(transaction, await captureIdentityAuthority(transaction, qualification));
      if (options.password !== false) await identity.insertPassword(userId, passwordHash, 0);
      if (options.provider)
        await identity.insertProvider(
          { userId, provider: options.provider, subject: options.subject ?? randomUUID() },
          0,
        );
    });
    const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 3_600_000);
    const raw =
      kind === 'legacy-jwe'
        ? await jwt.encode({
            secret,
            maxAge: 3600,
            token: {
              sub: userId,
              authSessionId: sid,
              gen: 0,
              ...(authenticatedAt
                ? { auth_time: authenticatedAt.getTime() / 1000, link_guarded: true }
                : { legacy_no_sid: true }),
            },
          })
        : randomBytes(32).toString('base64url');
    const legacyLineageId =
      options.source === 'bridge'
        ? `session:${sid}`
        : options.source === 'carried'
          ? `${CARRIED_WEB_SESSION_LINEAGE_PREFIX}${sid}`
          : null;
    if (kind === 'canonical-token') {
      await environment.database.insert(authSession).values({
        id: sid,
        userId,
        token: sessionTokenDigest(raw),
        expiresAt,
        updatedAt: new Date(),
        originalAuthenticatedAt: authenticatedAt,
        revocationGeneration: 0,
        legacyLineageId,
      });
      if (options.source === 'bridge')
        await environment.database.insert(authCredentialLineage).values({
          id: `session:${sid}`,
          userId,
          sessionId: sid,
          originalAuthenticatedAt: authenticatedAt,
          originalExpiresAt: expiresAt,
        });
    }
    const credential = kind === 'legacy-jwe' ? { kind, credential: raw, secret } : { kind, token: raw };
    // The raw cookie value and its kind.
    const presented = { kind, credential: raw };
    // The web-session actor of provider link, unlink and reauthentication.
    const webActor: ProviderSecurityActor = {
      presented: kind === 'legacy-jwe' ? { kind, credential: raw } : { kind, token: raw },
      expectedUserId: userId,
      expectedAuthSessionId: sid,
    };
    return { userId, sid, authenticatedAt, sourceExpiresAt: expiresAt, actor: presented, webActor, credential };
  }
  /** A new login of the same account: another live canonical session, and its credential. */
  async function secondSession(owner: Awaited<ReturnType<typeof actor>>) {
    const sessionId = randomUUID();
    const token = randomBytes(32).toString('base64url');
    await environment.database.insert(authSession).values({
      id: sessionId,
      userId: owner.userId,
      token: sessionTokenDigest(token),
      expiresAt: new Date(Date.now() + 3_600_000),
      updatedAt: new Date(),
      originalAuthenticatedAt: new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000),
      revocationGeneration: 0,
    });
    const webActor: ProviderSecurityActor = {
      presented: { kind: 'canonical-token', token },
      expectedUserId: owner.userId,
      expectedAuthSessionId: sessionId,
    };
    return { sessionId, webActor, credential: { kind: 'canonical-token' as const, token } };
  }
  async function prepareLink(owner: Awaited<ReturnType<typeof actor>>, provider: ProviderSecurityProvider = 'apple') {
    const intent = await createProviderSecurityIntent(environment.database, runtime, {
      actor: owner.webActor,
      action: 'link',
      provider,
      methodId: null,
    });
    const bound = { actor: owner.webActor, intentToken: intent.intentToken };
    const proof = await reauthenticateProviderWithPassword(environment.database, runtime, {
      ...bound,
      password: ' exact password ',
    });
    const flowHash = randomBytes(32).toString('hex');
    await bindProviderSecurityFlow(environment.database, runtime, { ...bound, flowHash });
    const subject = randomUUID();
    const prepared = await prepareProviderSecurityMutation(environment.database, runtime, {
      ...bound,
      reauthenticationToken: proof.reauthenticationToken,
      flowHash,
      providerProof: { provider, subject, email: 'different-verified@example.test', emailVerified: true },
    });
    if (prepared.outcome !== 'prepared') throw new Error('Owned provider preparation refused');
    return { ...intent, ...bound, ...proof, ...prepared, subject };
  }
  return { runtime, qualification, secret, passwordHash, actor, secondSession, selectAuthority, prepareLink };
}
