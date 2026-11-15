import { z } from 'zod';
import {
  browserBindingCursorSchema,
  browserSelectionPossessionSchema,
  browserSourceCredentialSchema,
} from './browser-binding-v1';
import { webCredentialProofSchema } from './web-credential-proof';

/** Private service protocol. No preparation, proof or capability is a public
 * authentication assertion. The installed issuer owns exact candidate bytes. */
export const BROWSER_PASSWORD_PROTOCOL_VERSION = 1;
export const BROWSER_PASSWORD_MODE_ENV = 'CURRENT_STORE_BROWSER_PASSWORD_MODE';
export const BROWSER_PASSWORD_PATH_PREFIX = '/api/internal/auth/browser-password/v1';
export const BROWSER_PASSWORD_COMMAND_PATHS = Object.freeze({
  prepare: `${BROWSER_PASSWORD_PATH_PREFIX}/prepare`,
  finalize: `${BROWSER_PASSWORD_PATH_PREFIX}/finalize`,
  acknowledge: `${BROWSER_PASSWORD_PATH_PREFIX}/acknowledge`,
  abort: `${BROWSER_PASSWORD_PATH_PREFIX}/abort`,
});
export const BROWSER_PASSWORD_REQUEST_BYTES = 65_536;
export const BROWSER_PASSWORD_RESPONSE_BYTES = 65_536;
export const BROWSER_PASSWORD_PREPARATION_MS = 60_000;
export const BROWSER_PASSWORD_ACK_MS = 300_000;
export const BROWSER_PASSWORD_CREDENTIAL_SECONDS = 30 * 24 * 60 * 60;

export function browserPasswordMode(
  environment: Readonly<Record<string, string | undefined>> = {},
): 'legacy' | 'backend-staging' {
  const mode = environment[BROWSER_PASSWORD_MODE_ENV];
  if (mode === undefined || mode === '' || mode === 'legacy') return 'legacy';
  if (mode === 'backend-staging') return mode;
  throw new Error('BROWSER_PASSWORD_MODE_INVALID');
}

const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.number().int().nonnegative().max(2_147_483_647);
const sourceVersion = version.max(2_147_483_646);
const credentialKind = z.enum(['legacy-jwe', 'canonical-token']);
const timestamp = z.iso.datetime();
const browserSource = { bindingToken: opaque, expectedVersion: sourceVersion };

/** A positive anonymous read is distinct from a missing selected proof. The
 * backend must read and lock the actual binding; a state label proves nothing. */
export const browserPasswordSourceSchema = z
  .discriminatedUnion('state', [
    z.object({ state: z.literal('anonymous'), ...browserSource }).strict(),
    z.object({ state: z.literal('selected'), ...browserSource, actor: browserSelectionPossessionSchema }).strict(),
  ])
  .superRefine((source, context) => {
    if (source.state === 'selected' && source.actor.version !== source.expectedVersion)
      context.addIssue({ code: 'custom', message: 'Password source version mismatch' });
  });
export type BrowserPasswordSource = z.infer<typeof browserPasswordSourceSchema>;

const freshProof = webCredentialProofSchema
  .omit({ requiresAccountCutoff: true })
  .extend({ authenticatedAt: timestamp, linkGuarded: z.literal(true) })
  .strict();
const sourceEvidence = z.discriminatedUnion('state', [
  z.object({ state: z.literal('anonymous') }).strict(),
  z
    .object({
      state: z.literal('selected'),
      credentialKind,
      credentialHash: digest,
      credentialProof: webCredentialProofSchema,
      expiresAt: timestamp,
    })
    .strict(),
]);

/** Hash-bound, backend-generated evidence. The full state hash is taken AFTER
 * this operation creates its own browser intent, never before that mutation. */
export const browserPasswordPreparationSchema = z
  .object({
    version: z.literal(1),
    purpose: z.literal('browser-password-publication-v1'),
    source: sourceEvidence,
    browserCursor: browserBindingCursorSchema,
    sourceIntentRevision: sourceVersion,
    intentRevision: version,
    preparedStateHash: digest,
    futureBrowserCursor: browserBindingCursorSchema,
    authority: z
      .object({
        projectionId: z.string().min(1).max(1_024),
        normalizerVersion: z.string().min(1).max(128),
        authority: z.enum(['current-store', 'better-auth']),
        epoch: z.number().int().min(1).max(2_147_483_647),
      })
      .strict(),
    nonceHash: digest,
    passwordStateHash: digest,
    credentialKind,
    /** The verifier's actual DB clock is retained independently of JWE seconds. */
    passwordVerifiedAt: timestamp,
    credentialProof: freshProof,
    credentialExpiresAt: timestamp,
    proposedCanonicalTokenHash: digest.nullable(),
    verification: z.object({ required: z.boolean(), verified: z.boolean() }).strict(),
    preparedAt: timestamp,
    expiresAt: timestamp,
    acknowledgeUntil: timestamp,
  })
  .strict()
  .superRefine((preparation, context) => {
    const preparedAt = Date.parse(preparation.preparedAt);
    const verifiedAt = Date.parse(preparation.passwordVerifiedAt);
    const authenticatedAt = Math.floor(verifiedAt / 1_000) * 1_000;
    const bindingDeadline = Date.parse(preparation.browserCursor.bindingExpiresAt);
    const sourceDeadline =
      preparation.source.state === 'selected' ? Date.parse(preparation.source.expiresAt) : Infinity;
    const expiresAt = Date.parse(preparation.expiresAt);
    if (
      verifiedAt > preparedAt ||
      preparedAt - verifiedAt > BROWSER_PASSWORD_PREPARATION_MS ||
      preparation.credentialProof.authenticatedAt !== new Date(authenticatedAt).toISOString() ||
      Date.parse(preparation.credentialExpiresAt) !== authenticatedAt + BROWSER_PASSWORD_CREDENTIAL_SECONDS * 1_000 ||
      preparation.browserCursor.version > 2_147_483_646 ||
      preparation.futureBrowserCursor.bindingId !== preparation.browserCursor.bindingId ||
      preparation.futureBrowserCursor.version !== preparation.browserCursor.version + 1 ||
      preparation.futureBrowserCursor.bindingExpiresAt !== preparation.browserCursor.bindingExpiresAt ||
      preparation.intentRevision !== preparation.sourceIntentRevision + 1 ||
      bindingDeadline <= preparedAt ||
      sourceDeadline <= preparedAt ||
      expiresAt <= preparedAt ||
      expiresAt > Math.min(preparedAt + BROWSER_PASSWORD_PREPARATION_MS, bindingDeadline, sourceDeadline) ||
      Date.parse(preparation.acknowledgeUntil) !== preparedAt + BROWSER_PASSWORD_ACK_MS ||
      (preparation.credentialKind === 'canonical-token') !== (preparation.proposedCanonicalTokenHash !== null) ||
      (preparation.source.state === 'selected' &&
        (preparation.source.credentialKind !== preparation.credentialKind ||
          preparation.source.credentialProof.authSessionId === preparation.credentialProof.authSessionId))
    )
      context.addIssue({ code: 'custom', message: 'Invalid browser password preparation' });
  });
export type BrowserPasswordPreparation = z.infer<typeof browserPasswordPreparationSchema>;

const metadata = {
  browserPasswordProtocolVersion: z.literal(1),
  requestId: z.uuidv4(),
  issuedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
};
const bound = {
  source: browserPasswordSourceSchema,
  operationToken: opaque,
  browserIntentToken: opaque,
  preparation: browserPasswordPreparationSchema,
};
export const browserPasswordCommandSchema = z
  .discriminatedUnion('operation', [
    z
      .object({
        ...metadata,
        operation: z.literal('prepare'),
        payload: z
          .object({
            source: browserPasswordSourceSchema,
            // Preserve the existing login byte policy: no trimming or registration bounds.
            email: z.string().min(1),
            password: z.string().min(1),
            credentialKind,
            nonceHash: digest,
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...metadata,
        operation: z.literal('finalize'),
        payload: z.object({ ...bound, candidate: browserSourceCredentialSchema }).strict(),
      })
      .strict(),
    z
      .object({
        ...metadata,
        operation: z.literal('acknowledge'),
        payload: z.object({ ...bound, candidate: browserSourceCredentialSchema }).strict(),
      })
      .strict(),
    z.object({ ...metadata, operation: z.literal('abort'), payload: z.object(bound).strict() }).strict(),
  ])
  .superRefine((command, context) => {
    const source = command.payload.source;
    if (command.operation === 'prepare') {
      if (source.state === 'selected' && source.actor.credential.kind !== command.payload.credentialKind)
        context.addIssue({ code: 'custom', message: 'Password credential kind mismatch' });
      return;
    }
    const preparation = command.payload.preparation;
    if (
      source.expectedVersion !== preparation.browserCursor.version ||
      source.state !== preparation.source.state ||
      (source.state === 'selected' && source.actor.credential.kind !== preparation.credentialKind) ||
      (command.operation !== 'abort' &&
        (command.payload.candidate.kind !== preparation.credentialKind ||
          (preparation.verification.required && !preparation.verification.verified)))
    )
      context.addIssue({ code: 'custom', message: 'Password command preparation mismatch' });
  });
export type BrowserPasswordCommand = z.infer<typeof browserPasswordCommandSchema>;

const reply = { browserPasswordProtocolVersion: z.literal(1), requestId: z.uuidv4() };
export const browserPasswordReplySchema = z.union([
  z.object({ ...reply, operation: z.literal('prepare'), outcome: z.literal('invalid_credentials') }).strict(),
  z
    .object({
      ...reply,
      operation: z.literal('prepare'),
      outcome: z.literal('prepared'),
      operationToken: opaque,
      browserIntentToken: opaque,
      preparation: browserPasswordPreparationSchema,
      proposedCanonicalToken: opaque.nullable(),
      user: z
        .object({
          id: z.string().min(1).max(1_024),
          email: z.string().min(1),
          name: z.string().nullable(),
          image: z.string().nullable(),
        })
        .strict(),
    })
    .strict()
    .superRefine((prepared, context) => {
      if (
        prepared.user.id !== prepared.preparation.credentialProof.userId ||
        (prepared.proposedCanonicalToken !== null) !== (prepared.preparation.credentialKind === 'canonical-token')
      )
        context.addIssue({ code: 'custom', message: 'Password prepared identity mismatch' });
    }),
  z
    .object({
      ...reply,
      operation: z.enum(['finalize', 'acknowledge']),
      outcome: z.literal('completed'),
      cursor: browserBindingCursorSchema,
      candidateCredentialHash: digest,
      credentialProof: freshProof,
      credentialExpiresAt: timestamp,
    })
    .strict()
    .superRefine((completed, context) => {
      const authenticatedAt = Date.parse(completed.credentialProof.authenticatedAt);
      if (
        authenticatedAt % 1_000 !== 0 ||
        Date.parse(completed.credentialExpiresAt) !== authenticatedAt + BROWSER_PASSWORD_CREDENTIAL_SECONDS * 1_000
      )
        context.addIssue({ code: 'custom', message: 'Password completed credential clock mismatch' });
    }),
  z.object({ ...reply, operation: z.literal('abort'), outcome: z.literal('aborted') }).strict(),
  z
    .object({
      ...reply,
      operation: z.enum(['prepare', 'finalize', 'acknowledge', 'abort']),
      outcome: z.enum(['denied', 'conflict', 'unavailable']),
    })
    .strict(),
]);
export type BrowserPasswordReply = z.infer<typeof browserPasswordReplySchema>;
export function browserPasswordReplyStatus(reply: BrowserPasswordReply): 200 | 401 | 409 | 503 {
  if (reply.outcome === 'denied' || reply.outcome === 'invalid_credentials') return 401;
  if (reply.outcome === 'conflict') return 409;
  if (reply.outcome === 'unavailable') return 503;
  return 200;
}
