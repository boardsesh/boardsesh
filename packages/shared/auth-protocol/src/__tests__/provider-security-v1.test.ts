import { expect, it } from 'vite-plus/test';
import {
  PROVIDER_SECURITY_VERSION,
  providerSecurityCommandSchema,
  providerSecurityMode,
  providerSecurityReplySchema,
  providerSecurityReplyStatus,
} from '../provider-security-v1';

const requestId = 'dbdf354c-33de-4f01-9c88-12bc1afde697';
const metadata = {
  providerSecurityVersion: PROVIDER_SECURITY_VERSION,
  requestId,
  issuedAt: '2026-11-13T12:00:00.000Z',
};
const token = 'A'.repeat(43);
const actor = {
  presented: { kind: 'canonical-token', token: 'exact-presented-session-token' },
  expectedUserId: 'current-owner',
  expectedAuthSessionId: 'current-session',
};
const bound = { actor, intentToken: token };
const bindingActor = {
  kind: 'legacy-jwe',
  credential: 'exact-presented-raw-cookie',
  expectedUserId: 'current-owner',
  expectedAuthSessionId: 'current-session',
  browserBindingToken: token,
  browserVersion: 7,
};
const candidate = { kind: 'legacy-jwe', credential: 'exact-locally-buffered-candidate' };

it.each(['signin-intent', 'signin-prepare', 'signin-finalize', 'signin-abort'])(
  'no longer accepts the browser-binding sign-in command %s: web OAuth resolve signs in (#7596 B5a)',
  (operation) => {
    expect(
      providerSecurityCommandSchema.safeParse({
        ...metadata,
        operation,
        payload: { actor: bindingActor, provider: 'apple', flowHash: 'c'.repeat(64), nonceHash: null },
      }).success,
    ).toBe(false);
  },
);

it.each(['intent', 'owned-provider'])('refuses Facebook at the %s product ingress', (operation) => {
  const payload =
    operation === 'intent'
      ? { actor, action: 'link', provider: 'facebook', methodId: null }
      : { actor, provider: 'facebook', subject: 'historical-imported-subject' };
  expect(providerSecurityCommandSchema.safeParse({ ...metadata, operation, payload }).success).toBe(false);
});

it('requires explicit verified target provider and refuses callback clocks as substitutes for reauthentication', () => {
  const payload = {
    ...bound,
    reauthenticationToken: token,
    flowHash: 'a'.repeat(64),
    providerProof: { subject: 'provider-subject', email: 'verified@example.test', emailVerified: true },
  };
  expect(providerSecurityCommandSchema.safeParse({ ...metadata, operation: 'prepare', payload }).success).toBe(false);
  expect(
    providerSecurityCommandSchema.safeParse({
      ...metadata,
      operation: 'prepare',
      payload: {
        ...payload,
        providerProof: { ...payload.providerProof, provider: 'apple' },
        authenticatedAt: metadata.issuedAt,
      },
    }).success,
  ).toBe(false);
  expect(
    providerSecurityCommandSchema.safeParse({
      ...metadata,
      operation: 'prepare',
      payload: { ...payload, providerProof: { ...payload.providerProof, provider: 'facebook' } },
    }).success,
  ).toBe(false);
});

it('preserves actual password bytes and captures a nested request copy', () => {
  const submitted = {
    ...metadata,
    operation: 'reauthenticate-password',
    payload: { ...bound, actor: { ...actor, presented: { ...actor.presented } }, password: ' exact password bytes ' },
  };
  const parsed = providerSecurityCommandSchema.parse(submitted);
  submitted.payload.actor.presented.token = 'later-cookie';
  submitted.payload.password = 'later-password';
  if (parsed.operation !== 'reauthenticate-password' || parsed.payload.actor.presented.kind !== 'canonical-token')
    throw new Error('Unexpected command narrowing');
  expect(parsed.payload.actor.presented.token).toBe(actor.presented.token);
  expect(parsed.payload.password).toBe(' exact password bytes ');
});

it('does not accept a caller-supplied verified subject or authentication time in a Google proof request', () => {
  const payload = { ...bound, flowHash: 'a'.repeat(64), nonce: 'operation-nonce', idToken: 'actual-signed-id-token' };
  expect(
    providerSecurityCommandSchema.safeParse({ ...metadata, operation: 'reauthenticate-google', payload }).success,
  ).toBe(true);
  for (const extra of [
    { verified: true },
    { subject: 'claimed-subject' },
    { authenticatedAt: metadata.issuedAt },
    { prompt: 'login' },
  ])
    expect(
      providerSecurityCommandSchema.safeParse({
        ...metadata,
        operation: 'reauthenticate-google',
        payload: { ...payload, ...extra },
      }).success,
    ).toBe(false);
});

it('link, unlink and their ACK recovery keep the session token: no candidate credential is accepted', () => {
  const recover = { ...bound, recoveryToken: token, reauthenticationToken: token };
  expect(providerSecurityCommandSchema.safeParse({ ...metadata, operation: 'recover', payload: recover }).success).toBe(
    true,
  );
  const finalize = { ...bound, reauthenticationToken: token, preparationToken: token };
  expect(
    providerSecurityCommandSchema.safeParse({ ...metadata, operation: 'finalize', payload: finalize }).success,
  ).toBe(true);
  for (const [operation, payload] of [
    ['recover', recover],
    ['finalize', finalize],
  ] as const)
    expect(
      providerSecurityCommandSchema.safeParse({ ...metadata, operation, payload: { ...payload, candidate } }).success,
    ).toBe(false);
});

it('provider security takes the web session, never a browser binding or a browser intent', () => {
  const payload = { actor, action: 'link', provider: 'google', methodId: null };
  expect(providerSecurityCommandSchema.safeParse({ ...metadata, operation: 'intent', payload }).success).toBe(true);
  for (const stale of [
    { ...payload, actor: bindingActor },
    { ...payload, actor: { ...actor, browserBindingToken: token, browserVersion: 7 } },
  ])
    expect(providerSecurityCommandSchema.safeParse({ ...metadata, operation: 'intent', payload: stale }).success).toBe(
      false,
    );
  expect(
    providerSecurityCommandSchema.safeParse({
      ...metadata,
      operation: 'bind',
      payload: { ...bound, browserIntentToken: token, flowHash: 'a'.repeat(64) },
    }).success,
  ).toBe(false);
  expect(
    providerSecurityCommandSchema.safeParse({
      ...metadata,
      operation: 'methods',
      payload: { actor: { ...actor, presented: { kind: 'legacy-jwe', credential: 'joined-nextauth-cookie' } } },
    }).success,
  ).toBe(true);
});

it('ACK replies cannot return, reconstruct or smuggle a credential bearer', () => {
  const reply = {
    providerSecurityVersion: PROVIDER_SECURITY_VERSION,
    requestId,
    operation: 'recover',
    outcome: 'recovered',
    generation: 3,
  };
  expect(providerSecurityReplySchema.safeParse(reply).success).toBe(true);
  expect(providerSecurityReplySchema.safeParse({ ...reply, candidate }).success).toBe(false);
  expect(providerSecurityReplySchema.safeParse({ ...reply, token }).success).toBe(false);
  expect(
    providerSecurityReplySchema.safeParse({
      ...reply,
      browserCursor: { bindingId: 'b'.repeat(64), version: 8, bindingExpiresAt: '2026-11-14T12:00:00.000Z' },
    }).success,
  ).toBe(false);
});

it.each([
  ['unauthenticated', 401],
  ['identity_changed', 409],
  ['canonical_session_required', 403],
  ['reauthentication_required', 403],
  ['reauthentication_unavailable', 403],
  ['denied', 400],
  ['unavailable', 503],
] as const)('retains %s as its exact private HTTP status', (outcome, expected) => {
  const reply = providerSecurityReplySchema.parse({
    providerSecurityVersion: PROVIDER_SECURITY_VERSION,
    requestId,
    operation: 'owned-provider',
    outcome,
    code: 'invalid_proof',
  });
  expect(providerSecurityReplyStatus(reply)).toBe(expected);
});

it('tells a legacy cookie that must be bridged apart from a missing reauthentication', () => {
  const reply = providerSecurityReplySchema.parse({
    providerSecurityVersion: PROVIDER_SECURITY_VERSION,
    requestId,
    operation: 'intent',
    outcome: 'canonical_session_required',
    code: 'canonical_session_required',
  });
  expect(reply.outcome).not.toBe('reauthentication_required');
  expect(providerSecurityReplyStatus(reply)).toBe(403);
});

it('keeps provider mutation dark by default and refuses unknown selectors', () => {
  expect(providerSecurityMode({})).toBe('legacy');
  expect(providerSecurityMode({ CURRENT_STORE_PROVIDER_SECURITY_MODE: 'backend-staging' })).toBe('backend-staging');
  expect(() => providerSecurityMode({ CURRENT_STORE_PROVIDER_SECURITY_MODE: 'enabled' })).toThrow();
});
