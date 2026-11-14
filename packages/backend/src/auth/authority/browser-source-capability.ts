import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { executeFirstRow } from '@boardsesh/db/client';
import { authBrowserBindings, authCredentialLineage, authSession, users } from '@boardsesh/db/schema/auth';
import { z } from 'zod';
import type { AuthorityDatabase, AuthorityTransaction } from './adapter';
import { captureIdentityAuthority, revalidateIdentityAuthority, type IdentityAuthorityQualification } from './router';
import { readBrowserBindingInTransaction, type BrowserSelectionCredential } from './browser-binding';
import type { FirstPartySession } from './session-reader';
import type { WebCredentialProof } from '@boardsesh/auth-protocol';
import { transactionSettings } from '../current-store/command-context';
import { readLockedWebSubjectState } from '../current-store/web-credential-state';
import { decideCredential } from '../credential-cutoffs';

/** Both fixed purposes require actual source possession when issued. The
 * backend delegation is never accepted as a native handoff or source proof. */
export const BROWSER_SOURCE_CAPABILITY_LIFETIME_MS = 120_000;
const families = {
  'backend-delegation': {
    prefix: 'bsbd1_',
    keyEnvironment: 'BROWSER_DELEGATION_SECRET',
    audience: 'boardsesh-first-party-backend',
    context: 'boardsesh/browser-backend-delegation/v1',
    keyContext: 'backend-only-aead-key',
    maximumTokenBytes: 4096,
  },
  'native-handoff': {
    prefix: 'bsnh1_',
    keyEnvironment: 'NATIVE_BROWSER_HANDOFF_SECRET',
    audience: 'boardsesh-native-browser-handoff',
    context: 'boardsesh/browser-native-handoff/v1',
    keyContext: 'native-handoff-aead-key',
    maximumTokenBytes: 4000,
  },
} as const;
export type BrowserSourceCapabilityPurpose = keyof typeof families;
export type BrowserSourceCapabilityDatabase = AuthorityDatabase | (() => Promise<AuthorityDatabase>);
const hash = (source: string) => createHash('sha256').update(source).digest('hex');
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const identifier = z.string().min(1).max(1024);
const generation = z.number().int().min(0).max(2_147_483_647);
const nativeCreationSchema = z
  .object({
    userId: identifier,
    accountCreated: z.boolean(),
    provider: z.enum(['google', 'apple']),
    createdAt: z.iso.datetime(),
    attemptId: z.string().regex(/^[a-f0-9]{32}$/),
    completedAt: timestamp,
  })
  .strict();
export type NativeBrowserCreationMetadata = z.infer<typeof nativeCreationSchema>;
/** Trusted backend result from the known completed provider receipt, not a
 * public request's accountCreated field. Source admission remains independent. */
export interface NativeBrowserCreationContext {
  readonly metadata?: NativeBrowserCreationMetadata;
  readonly proof: WebCredentialProof;
  readonly cursor: { readonly bindingId: string; readonly version: number; readonly bindingExpiresAt: string };
  readonly credentialExpiresAt: string;
  readonly markerExpiresAt?: number;
  readonly receiptExpiresAt: number;
  readonly authority: {
    readonly projectionId: string;
    readonly normalizerVersion: string;
    readonly authority: 'current-store' | 'better-auth';
    readonly epoch: number;
  };
}
const claimsSchema = z
  .object({
    format: z.literal(1),
    audience: z.enum(['boardsesh-first-party-backend', 'boardsesh-native-browser-handoff']),
    bindingId: digestSchema,
    version: generation,
    bindingExpiresAt: timestamp,
    sourceKind: z.enum(['legacy-jwe', 'canonical-token']),
    sourceHash: digestSchema,
    legacyKeyDigest: digestSchema.nullable(),
    userId: identifier,
    authSessionId: identifier,
    generation,
    authenticatedAt: timestamp.nullable(),
    sourceExpiresAt: timestamp,
    linkGuarded: z.boolean(),
    requiresAccountCutoff: z.boolean(),
    projectionId: identifier,
    normalizerVersion: identifier,
    authority: z.enum(['current-store', 'better-auth']),
    epoch: generation,
    issuedAt: timestamp,
    expiresAt: timestamp,
    nativeCreation: nativeCreationSchema.optional(),
  })
  .strict()
  .refine(
    (claims) =>
      (claims.nativeCreation === undefined ||
        (claims.audience === 'boardsesh-native-browser-handoff' &&
          claims.nativeCreation.userId === claims.userId &&
          claims.nativeCreation.completedAt <= claims.issuedAt &&
          Date.parse(claims.nativeCreation.createdAt) <= claims.nativeCreation.completedAt)) &&
      (claims.sourceKind === 'legacy-jwe') === (claims.legacyKeyDigest !== null) &&
      claims.linkGuarded === (claims.authenticatedAt !== null) &&
      claims.expiresAt > claims.issuedAt &&
      claims.expiresAt <=
        Math.min(
          claims.sourceExpiresAt,
          claims.bindingExpiresAt,
          claims.issuedAt + BROWSER_SOURCE_CAPABILITY_LIFETIME_MS,
        ),
  );
type Claims = z.infer<typeof claimsSchema>;
type Environment = Readonly<Record<string, string | undefined>>;
type Refusal = { readonly status: 'denied' | 'conflict' | 'unavailable' };
export type BrowserSourceCapabilityAdmission<Result> =
  | {
      readonly status: 'admitted';
      readonly session: FirstPartySession;
      readonly expiresAt: Date;
      readonly result: Result;
    }
  | Refusal;
class CapabilityExpired extends Error {}

function capabilityKey(environment: Environment, purpose: BrowserSourceCapabilityPurpose): Buffer {
  const family = families[purpose];
  const secret = environment[family.keyEnvironment];
  if (
    !secret ||
    secret !== secret.trim() ||
    Buffer.byteLength(secret, 'utf8') < 32 ||
    [
      'NEXTAUTH_SECRET',
      'CURRENT_STORE_AUTH_RPC_SECRET',
      'CRON_SECRET',
      'CURRENT_STORE_DELETED_EMAIL_KEY',
      'BROWSER_DELEGATION_SECRET',
      'NATIVE_BROWSER_HANDOFF_SECRET',
    ].some((name) => name !== family.keyEnvironment && Boolean(environment[name]) && secret === environment[name])
  )
    throw new Error('BROWSER_DELEGATION_KEY_UNAVAILABLE');
  return Buffer.from(hkdfSync('sha256', secret, family.context, family.keyContext, 32));
}
function seal(claims: Claims, key: Buffer, purpose: BrowserSourceCapabilityPurpose): string {
  const family = families[purpose];
  const aad = Buffer.from(family.context);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(claims), 'utf8'), cipher.final()]);
  const token = family.prefix + Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64url');
  if (Buffer.byteLength(token, 'utf8') > family.maximumTokenBytes) throw new Error('BROWSER_DELEGATION_TOO_LARGE');
  return token;
}
function open(token: string, key: Buffer, purpose: BrowserSourceCapabilityPurpose): Claims | undefined {
  try {
    const family = families[purpose];
    const aad = Buffer.from(family.context);
    if (!token.startsWith(family.prefix) || Buffer.byteLength(token, 'utf8') > family.maximumTokenBytes) return;
    const encoded = token.slice(family.prefix.length);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return;
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.length <= 28 || bytes.toString('base64url') !== encoded) return;
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAAD(aad);
    decipher.setAuthTag(bytes.subarray(-16));
    const plaintext = Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
    const parsed = claimsSchema.safeParse(JSON.parse(plaintext.toString('utf8')));
    return parsed.success && parsed.data.audience === family.audience ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
async function databaseNow(transaction: AuthorityTransaction): Promise<Date> {
  const clock = await executeFirstRow<{ now: Date | string }>(transaction, sql`SELECT clock_timestamp() AS now`);
  const now = clock ? new Date(clock.now) : new Date(NaN);
  if (!Number.isFinite(now.getTime())) throw new Error('BROWSER_DELEGATION_CLOCK_UNAVAILABLE');
  return now;
}
function matchesSession(claims: Claims, session: FirstPartySession): boolean {
  return (
    claims.userId === session.userId &&
    claims.authSessionId === session.authSessionId &&
    claims.generation === session.generation &&
    claims.authenticatedAt === (session.authenticatedAt?.getTime() ?? null) &&
    claims.linkGuarded === session.linkGuarded &&
    claims.requiresAccountCutoff === session.requiresAccountCutoff &&
    session.expiresAt.getTime() >= claims.sourceExpiresAt
  );
}

/** The only issuer accepts actual source bytes and performs its own primary
 * admission. There is no exported signer accepting an asserted UID or SID. */
export async function issueBrowserSourceCapability(
  database: AuthorityDatabase,
  qualification: IdentityAuthorityQualification,
  purpose: BrowserSourceCapabilityPurpose,
  requested: { readonly bindingToken: string; readonly actor: BrowserSelectionCredential },
  environmentInput: Environment = process.env,
  nativeCreationInput?: NativeBrowserCreationContext,
): Promise<
  | Refusal
  | {
      readonly status: 'admitted';
      readonly token: string;
      readonly issuedAt: Date;
      readonly expiresAt: Date;
      readonly cursor: { readonly bindingId: string; readonly version: number; readonly bindingExpiresAt: Date };
      readonly session: FirstPartySession;
    }
> {
  const environment = Object.freeze({ ...environmentInput });
  const nativeCreation = nativeCreationInput ? structuredClone(nativeCreationInput) : undefined;
  qualification = Object.freeze({ ...qualification });
  const input = {
    bindingToken: requested.bindingToken,
    actor: { ...requested.actor, credential: { ...requested.actor.credential } },
  };
  try {
    const key = capabilityKey(environment, purpose);
    return await database.transaction(async (transaction) => {
      await transactionSettings(transaction);
      const authority = await captureIdentityAuthority(transaction, qualification);
      const selected = await readBrowserBindingInTransaction(transaction, authority, input);
      if (selected.status !== 'admitted')
        return { status: selected.status === 'anonymous' ? 'denied' : selected.status };
      const source = input.actor.credential;
      if (source.kind === 'legacy-jwe' && source.secret !== environment.NEXTAUTH_SECRET)
        return { status: 'unavailable' };
      const now = await databaseNow(transaction);
      if (nativeCreation) {
        const proof = nativeCreation.proof;
        const metadata = nativeCreation.metadata;
        if (
          purpose !== 'native-handoff' ||
          nativeCreation.receiptExpiresAt <= now.getTime() ||
          (nativeCreation.markerExpiresAt !== undefined && nativeCreation.markerExpiresAt < now.getTime()) ||
          nativeCreation.authority.projectionId !== authority.projectionId ||
          nativeCreation.authority.normalizerVersion !== authority.normalizerVersion ||
          nativeCreation.authority.authority !== authority.authority ||
          nativeCreation.authority.epoch !== authority.epoch ||
          nativeCreation.cursor.bindingId !== selected.cursor.bindingId ||
          nativeCreation.cursor.version !== selected.cursor.version ||
          nativeCreation.cursor.bindingExpiresAt !== selected.cursor.bindingExpiresAt.toISOString() ||
          nativeCreation.credentialExpiresAt !== selected.session.expiresAt.toISOString() ||
          proof.userId !== selected.session.userId ||
          proof.authSessionId !== selected.session.authSessionId ||
          proof.generation !== selected.session.generation ||
          proof.authenticatedAt !== (selected.session.authenticatedAt?.toISOString() ?? null) ||
          proof.linkGuarded !== selected.session.linkGuarded ||
          Boolean(proof.requiresAccountCutoff) !== selected.session.requiresAccountCutoff ||
          (metadata !== undefined &&
            (metadata.userId !== selected.session.userId || metadata.completedAt > now.getTime()))
        )
          return { status: 'conflict' };
      }
      const expiresAt = new Date(
        Math.min(
          now.getTime() + BROWSER_SOURCE_CAPABILITY_LIFETIME_MS,
          selected.session.expiresAt.getTime(),
          selected.cursor.bindingExpiresAt.getTime(),
        ),
      );
      if (expiresAt.getTime() <= now.getTime()) return { status: 'denied' };
      const claims = claimsSchema.parse({
        format: 1,
        audience: families[purpose].audience,
        bindingId: selected.cursor.bindingId,
        version: selected.cursor.version,
        bindingExpiresAt: selected.cursor.bindingExpiresAt.getTime(),
        sourceKind: source.kind,
        sourceHash: hash(source.kind === 'canonical-token' ? source.token : source.credential),
        legacyKeyDigest: source.kind === 'legacy-jwe' ? hash(source.secret) : null,
        ...selected.session,
        authenticatedAt: selected.session.authenticatedAt?.getTime() ?? null,
        sourceExpiresAt: selected.session.expiresAt.getTime(),
        expiresAt: expiresAt.getTime(),
        projectionId: authority.projectionId,
        normalizerVersion: authority.normalizerVersion,
        authority: authority.authority,
        epoch: authority.epoch,
        issuedAt: now.getTime(),
        ...(nativeCreation?.metadata ? { nativeCreation: nativeCreation.metadata } : {}),
      });
      const token = seal(claims, key, purpose);
      await revalidateIdentityAuthority(transaction, authority);
      const finishedAt = (await databaseNow(transaction)).getTime();
      if (
        finishedAt >= expiresAt.getTime() ||
        (nativeCreation &&
          (finishedAt >= nativeCreation.receiptExpiresAt ||
            (nativeCreation.markerExpiresAt !== undefined && finishedAt > nativeCreation.markerExpiresAt)))
      )
        return { status: 'denied' };
      return {
        status: 'admitted',
        token,
        issuedAt: now,
        expiresAt,
        cursor: selected.cursor,
        session: selected.session,
      };
    });
  } catch {
    return { status: 'unavailable' };
  }
}

/** Reads metadata only. The exact encrypted token hash AND SID must match the
 * canonical primary row; no stored token is fetched or materialized from a SID. */
async function canonicalSession(
  transaction: AuthorityTransaction,
  claims: Claims,
): Promise<FirstPartySession | undefined> {
  const [canonical] = await transaction
    .select({
      id: authSession.id,
      userId: authSession.userId,
      expiresAt: authSession.expiresAt,
      legacyLineageId: authSession.legacyLineageId,
      revocationGeneration: authSession.revocationGeneration,
      originalAuthenticatedAt: authSession.originalAuthenticatedAt,
    })
    .from(authSession)
    .where(
      and(
        eq(authSession.id, claims.authSessionId),
        eq(
          sql<string>`pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(${authSession.token}, 'UTF8')), 'hex')`,
          claims.sourceHash,
        ),
      ),
    );
  if (!canonical) return;
  if (canonical.legacyLineageId) {
    const [lineage] = await transaction
      .select()
      .from(authCredentialLineage)
      .where(eq(authCredentialLineage.id, canonical.legacyLineageId));
    if (lineage && (lineage.revokedAt || lineage.userId !== canonical.userId || lineage.sessionId !== canonical.id))
      return;
  }
  return {
    userId: canonical.userId,
    authSessionId: canonical.id,
    generation: canonical.revocationGeneration ?? 0,
    authenticatedAt: canonical.originalAuthenticatedAt,
    expiresAt: canonical.expiresAt,
    requiresAccountCutoff: canonical.legacyLineageId?.startsWith('credential:') ?? false,
    linkGuarded: canonical.originalAuthenticatedAt !== null,
  };
}

/** Every use reads primary selection, authority and revocation state. Crypto
 * output stays local to this module; callers cannot supply decrypted claims. */
export async function useBrowserSourceCapability<Result>(
  databaseInput: BrowserSourceCapabilityDatabase,
  qualification: IdentityAuthorityQualification,
  purpose: BrowserSourceCapabilityPurpose,
  token: string,
  operation: (
    transaction: AuthorityTransaction,
    session: FirstPartySession,
    expiresAt: Date,
    nativeCreation?: NativeBrowserCreationMetadata,
  ) => Promise<Result>,
  environmentInput: Environment = process.env,
): Promise<BrowserSourceCapabilityAdmission<Result>> {
  const environment = Object.freeze({ ...environmentInput });
  qualification = Object.freeze({ ...qualification });
  try {
    const claims = open(token, capabilityKey(environment, purpose), purpose);
    if (!claims) return { status: 'denied' };
    if (claims.sourceKind === 'legacy-jwe') {
      if (!environment.NEXTAUTH_SECRET) return { status: 'unavailable' };
      if (hash(environment.NEXTAUTH_SECRET) !== claims.legacyKeyDigest) return { status: 'denied' };
    }
    const database = typeof databaseInput === 'function' ? await databaseInput() : databaseInput;
    return await database.transaction(async (transaction) => {
      await transactionSettings(transaction);
      const authority = await captureIdentityAuthority(transaction, qualification);
      if (
        authority.projectionId !== claims.projectionId ||
        authority.normalizerVersion !== claims.normalizerVersion ||
        authority.authority !== claims.authority ||
        authority.epoch !== claims.epoch
      )
        return { status: 'denied' };
      await transaction.select({ id: users.id }).from(users).where(eq(users.id, claims.userId)).for('update');
      const [binding] = await transaction
        .select()
        .from(authBrowserBindings)
        .where(eq(authBrowserBindings.id, claims.bindingId))
        .for('update');
      const now = await databaseNow(transaction);
      if (
        !binding ||
        binding.version !== claims.version ||
        binding.credentialKind !== claims.sourceKind ||
        binding.expiresAt.getTime() !== claims.bindingExpiresAt ||
        claims.issuedAt > now.getTime() ||
        claims.expiresAt <= now.getTime() ||
        binding.userId !== claims.userId ||
        binding.authSessionId !== claims.authSessionId ||
        binding.generation !== claims.generation ||
        (binding.authenticatedAt?.getTime() ?? null) !== claims.authenticatedAt ||
        binding.linkGuarded !== claims.linkGuarded ||
        binding.requiresAccountCutoff !== claims.requiresAccountCutoff ||
        !binding.credentialExpiresAt ||
        binding.credentialExpiresAt.getTime() < claims.sourceExpiresAt
      )
        return { status: 'denied' };
      const session: FirstPartySession | undefined =
        claims.sourceKind === 'canonical-token'
          ? await canonicalSession(transaction, claims)
          : {
              userId: claims.userId,
              authSessionId: claims.authSessionId,
              generation: claims.generation,
              authenticatedAt: claims.authenticatedAt === null ? null : new Date(claims.authenticatedAt),
              expiresAt: new Date(claims.sourceExpiresAt),
              linkGuarded: claims.linkGuarded,
              requiresAccountCutoff: claims.requiresAccountCutoff,
            };
      if (!session || !matchesSession(claims, session)) return { status: 'denied' };
      const subject = await readLockedWebSubjectState(transaction, claims.userId);
      const decision = decideCredential(
        {
          kind: 'web-session',
          generationClaim: session.generation,
          sessionKeyClaim: session.authSessionId,
          authTimeClaim: session.authenticatedAt ? session.authenticatedAt.getTime() / 1000 : null,
        },
        subject,
        now.getTime(),
      );
      if (decision.denial !== null) return { status: 'denied' };
      const boundedSession = { ...session, expiresAt: new Date(claims.sourceExpiresAt) };
      const expiresAt = new Date(claims.expiresAt);
      const result = await operation(transaction, boundedSession, expiresAt, claims.nativeCreation);
      await revalidateIdentityAuthority(transaction, authority);
      // An issuer may already have inserted child rows. Throwing rolls its
      // receipt and credentials back together when a final deadline is lost.
      if ((await databaseNow(transaction)).getTime() >= claims.expiresAt) throw new CapabilityExpired();
      return { status: 'admitted', session: boundedSession, expiresAt, result };
    });
  } catch (error) {
    return { status: error instanceof CapabilityExpired ? 'denied' : 'unavailable' };
  }
}
