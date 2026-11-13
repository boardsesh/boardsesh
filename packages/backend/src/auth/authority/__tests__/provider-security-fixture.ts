import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { hash } from 'bcryptjs';
import { vi } from 'vite-plus/test';
import { authEmailProjection, authSession, users } from '@boardsesh/db/schema/auth';
import type { ProviderSecurityActor, ProviderSecurityProvider } from '@boardsesh/auth-protocol';
import { createEnvironment } from './environment';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../current-store/foundation-context';
import { prepareProjectionUnderUsersTableLock } from '../../current-store/email-reservations';
import { captureIdentityAuthority, switchIdentityAuthority, type IdentityAuthorityName } from '../router';
import { bindIdentityAuthority } from '../identity-authority';
import type { AuthorityDatabase } from '../adapter';
import { beginBrowserIntent, commitBrowserLogin, createUnpublishedBrowserBinding } from '../browser-binding';
import {
  bindProviderSecurityFlow,
  createProviderSecurityIntent,
  type ProviderSecurityRuntime,
} from '../provider-security-intents';
import { reauthenticateProviderWithPassword } from '../provider-security-reauthentication';
import { prepareProviderSecurityMutation } from '../provider-security-finalizer';

const requireWeb = createRequire(new URL('../../../../../web/package.json', import.meta.url));
const jwt = requireWeb('next-auth/jwt') as {
  encode(input: { secret: string; token: Record<string, unknown>; maxAge: number }): Promise<string>;
};
export async function createProviderSecurityEnvironment() {
  const environment = await createEnvironment();
  try {
    for (const filename of [
      '0311_browser_binding_selection.sql',
      '0312_browser_selection_possession.sql',
      '0313_provider_security_receipts.sql',
    ])
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
    kind: ProviderSecurityActor['kind'],
    options: {
      readonly password?: boolean;
      readonly provider?: ProviderSecurityProvider;
      readonly subject?: string;
      readonly unknownAge?: boolean;
    } = {},
  ) {
    await selectAuthority(selected);
    const userId = randomUUID();
    const sid = randomUUID();
    const authenticatedAt = options.unknownAge ? null : new Date(Math.floor(Date.now() / 1000) * 1000 - 86_400_000);
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
    if (kind === 'canonical-token')
      await environment.database.insert(authSession).values({
        id: sid,
        userId,
        token: raw,
        expiresAt,
        updatedAt: new Date(),
        originalAuthenticatedAt: authenticatedAt,
        revocationGeneration: 0,
      });
    const credential = kind === 'legacy-jwe' ? { kind, credential: raw, secret } : { kind, token: raw };
    const binding = await createUnpublishedBrowserBinding(
      environment.database,
      qualification,
      new Date(Date.now() + 86_400_000),
    );
    if (binding.status !== 'created') throw new Error('Owned binding initialization failed');
    const login = await beginBrowserIntent(environment.database, qualification, binding.token, {
      operation: 'login',
      expectedVersion: 0,
    });
    if (login.status !== 'prepared') throw new Error('Owned login intent failed');
    const admitted = await commitBrowserLogin(
      environment.database,
      qualification,
      binding.token,
      login.intentToken,
      credential,
    );
    if (admitted.status !== 'committed') throw new Error('Owned issuance did not admit');
    const presented: ProviderSecurityActor = {
      kind,
      credential: raw,
      expectedUserId: userId,
      expectedAuthSessionId: sid,
      browserBindingToken: binding.token,
      browserVersion: admitted.cursor.version,
    };
    return { userId, sid, authenticatedAt, sourceExpiresAt: expiresAt, actor: presented, credential };
  }
  async function prepareLink(owner: Awaited<ReturnType<typeof actor>>, provider: ProviderSecurityProvider = 'apple') {
    const intent = await createProviderSecurityIntent(environment.database, runtime, {
      actor: owner.actor,
      action: 'link',
      provider,
      methodId: null,
    });
    const bound = {
      actor: owner.actor,
      intentToken: intent.intentToken,
      browserIntentToken: intent.browserIntentToken,
    };
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
  async function candidate(
    prepared: Pick<
      Awaited<ReturnType<typeof prepareLink>>,
      'proposedCanonicalToken' | 'credentialProof' | 'credentialExpiresAt'
    >,
    kind: ProviderSecurityActor['kind'],
  ) {
    if (kind === 'canonical-token') {
      if (!prepared.proposedCanonicalToken) throw new Error('Missing private canonical proposal');
      return { kind, credential: prepared.proposedCanonicalToken };
    }
    const proof = prepared.credentialProof;
    const fixedMilliseconds = Math.floor(Date.now() / 1000) * 1000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(fixedMilliseconds);
    try {
      return {
        kind,
        credential: await jwt.encode({
          secret,
          maxAge: prepared.credentialExpiresAt.getTime() / 1000 - fixedMilliseconds / 1000,
          token: {
            sub: proof.userId,
            authSessionId: proof.authSessionId,
            gen: proof.generation,
            ...(proof.authenticatedAt ? { auth_time: Date.parse(proof.authenticatedAt) / 1000 } : {}),
            ...(proof.linkGuarded ? { link_guarded: true } : {}),
            ...(proof.requiresAccountCutoff ? { legacy_no_sid: true } : {}),
          },
        }),
      };
    } finally {
      clock.mockRestore();
    }
  }
  return { runtime, qualification, secret, passwordHash, actor, selectAuthority, prepareLink, candidate };
}
