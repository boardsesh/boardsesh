import { describe, expect, it } from 'vite-plus/test';
import { AUTH_COMMAND_REQUEST_BYTES, AUTH_COMMAND_RESPONSE_BYTES, passwordReplySchema } from '../index';
import {
  BROWSER_PASSWORD_COMMAND_PATHS,
  BROWSER_PASSWORD_CREDENTIAL_SECONDS,
  browserPasswordCommandSchema,
  browserPasswordMode,
  browserPasswordPreparationSchema,
  browserPasswordReplySchema,
  browserPasswordReplyStatus,
  type BrowserPasswordPreparation,
  type BrowserPasswordSource,
} from '../browser-password-v1';

const requestId = 'ca113c0f-a666-44e5-8f69-81036cb169ae';
const preparedAt = Date.parse('2026-11-15T16:00:00.900Z');
const verifiedAt = '2026-11-15T16:00:00.789Z';
const authenticatedAt = '2026-11-15T16:00:00.000Z';
const metadata = { browserPasswordProtocolVersion: 1, requestId, issuedAt: preparedAt };
const opaque = 'a'.repeat(43);
function preparation(
  kind: 'legacy-jwe' | 'canonical-token' = 'legacy-jwe',
  selected = false,
): BrowserPasswordPreparation {
  const cursor = {
    bindingId: 'b'.repeat(64),
    version: 7,
    bindingExpiresAt: new Date(preparedAt + 10 * 86_400_000).toISOString(),
  };
  return {
    version: 1,
    purpose: 'browser-password-publication-v1',
    source: selected
      ? {
          state: 'selected',
          credentialKind: kind,
          credentialHash: 'c'.repeat(64),
          credentialProof: {
            version: 1,
            userId: 'original-A',
            authSessionId: 'original-SID',
            generation: 2,
            authenticatedAt: null,
            linkGuarded: false,
          },
          expiresAt: new Date(preparedAt + 3_600_000).toISOString(),
        }
      : { state: 'anonymous' },
    browserCursor: cursor,
    sourceIntentRevision: 4,
    intentRevision: 5,
    preparedStateHash: 'd'.repeat(64),
    futureBrowserCursor: { ...cursor, version: 8 },
    authority: {
      projectionId: 'owned-projection',
      normalizerVersion: 'owned-normalizer',
      authority: 'current-store',
      epoch: 1,
    },
    nonceHash: 'e'.repeat(64),
    passwordStateHash: 'f'.repeat(64),
    credentialKind: kind,
    passwordVerifiedAt: verifiedAt,
    credentialProof: {
      version: 1,
      userId: 'matched-B',
      authSessionId: 'fresh-SID',
      generation: 3,
      authenticatedAt,
      linkGuarded: true,
    },
    credentialExpiresAt: new Date(
      Date.parse(authenticatedAt) + BROWSER_PASSWORD_CREDENTIAL_SECONDS * 1_000,
    ).toISOString(),
    proposedCanonicalTokenHash: kind === 'canonical-token' ? '1'.repeat(64) : null,
    verification: { required: true, verified: true },
    preparedAt: new Date(preparedAt).toISOString(),
    expiresAt: new Date(preparedAt + 60_000).toISOString(),
    acknowledgeUntil: new Date(preparedAt + 300_000).toISOString(),
  };
}
function source(selected = false, kind: 'legacy-jwe' | 'canonical-token' = 'legacy-jwe'): BrowserPasswordSource {
  return selected
    ? {
        state: 'selected',
        bindingToken: opaque,
        expectedVersion: 7,
        actor: {
          version: 7,
          credential:
            kind === 'canonical-token' ? { kind, token: opaque } : { kind, credential: 'actual-original-jwe' },
        },
      }
    : { state: 'anonymous', bindingToken: opaque, expectedVersion: 7 };
}
function prepareCommand(selected = false, kind: 'legacy-jwe' | 'canonical-token' = 'legacy-jwe') {
  return {
    ...metadata,
    operation: 'prepare',
    payload: {
      source: source(selected, kind),
      email: ' Owner@Example.test ',
      password: '  unchanged\u0000密码  ',
      credentialKind: kind,
      nonceHash: 'e'.repeat(64),
    },
  };
}
function boundCommand(
  operation: 'finalize' | 'acknowledge' | 'abort' = 'finalize',
  selected = false,
  kind: 'legacy-jwe' | 'canonical-token' = 'legacy-jwe',
) {
  return {
    ...metadata,
    operation,
    payload: {
      source: source(selected, kind),
      operationToken: opaque,
      browserIntentToken: opaque,
      preparation: preparation(kind, selected),
      ...(operation === 'abort'
        ? {}
        : {
            candidate:
              kind === 'canonical-token'
                ? { kind, token: opaque }
                : { kind, credential: 'actual-issued-candidate-jwe' },
          }),
    },
  };
}
function preparedReply(kind: 'legacy-jwe' | 'canonical-token' = 'legacy-jwe') {
  return {
    browserPasswordProtocolVersion: 1,
    requestId,
    operation: 'prepare',
    outcome: 'prepared',
    operationToken: opaque,
    browserIntentToken: opaque,
    preparation: preparation(kind),
    proposedCanonicalToken: kind === 'canonical-token' ? opaque : null,
    user: { id: 'matched-B', email: 'owner@example.test', name: null, image: null },
  };
}

describe('private browser password publication protocol', () => {
  it('defaults to legacy and rejects unknown activation values', () => {
    expect(browserPasswordMode()).toBe('legacy');
    for (const mode of ['', 'legacy'])
      expect(browserPasswordMode({ CURRENT_STORE_BROWSER_PASSWORD_MODE: mode })).toBe('legacy');
    expect(browserPasswordMode({ CURRENT_STORE_BROWSER_PASSWORD_MODE: 'backend-staging' })).toBe('backend-staging');
    for (const mode of ['on', 'true', 'production', 'BACKEND-STAGING'])
      expect(() => browserPasswordMode({ CURRENT_STORE_BROWSER_PASSWORD_MODE: mode })).toThrow();
  });
  it('has four fixed service-only destinations', () => {
    expect(BROWSER_PASSWORD_COMMAND_PATHS).toEqual({
      prepare: '/api/internal/auth/browser-password/v1/prepare',
      finalize: '/api/internal/auth/browser-password/v1/finalize',
      acknowledge: '/api/internal/auth/browser-password/v1/acknowledge',
      abort: '/api/internal/auth/browser-password/v1/abort',
    });
  });
  it.each(['legacy-jwe', 'canonical-token'] as const)(
    'preserves actual password bytes and supports positive anonymous or selected %s source',
    (kind) => {
      for (const selected of [false, true])
        expect(browserPasswordCommandSchema.parse(prepareCommand(selected, kind))).toEqual(
          prepareCommand(selected, kind),
        );
    },
  );
  it('preserves an existing login email longer than 8192 characters within transport bounds', () => {
    const email = 'a'.repeat(8_193);
    const prepared = preparedReply();
    const legacy = {
      protocolVersion: 2,
      operation: 'password',
      requestId,
      outcome: 'authenticated',
      credentialProof: prepared.preparation.credentialProof,
      user: { ...prepared.user, email },
      verification: { userId: prepared.user.id, required: true, verified: true },
    };
    const command = prepareCommand();
    command.payload.email = email;
    const reply = { ...prepared, user: { ...prepared.user, email } };
    expect(passwordReplySchema.parse(legacy)).toEqual(legacy);
    expect(new TextEncoder().encode(JSON.stringify(command)).byteLength).toBeLessThan(AUTH_COMMAND_REQUEST_BYTES);
    expect(new TextEncoder().encode(JSON.stringify(reply)).byteLength).toBeLessThan(AUTH_COMMAND_RESPONSE_BYTES);
    expect(browserPasswordCommandSchema.parse(command)).toEqual(command);
    expect(browserPasswordReplySchema.parse(reply)).toEqual(reply);
  });
  it('never coerces a missing selected source proof to anonymous', () => {
    const command = prepareCommand(true);
    const { actor: _actor, ...withoutActor } = command.payload.source as Extract<
      BrowserPasswordSource,
      { state: 'selected' }
    >;
    expect(
      browserPasswordCommandSchema.safeParse({ ...command, payload: { ...command.payload, source: withoutActor } })
        .success,
    ).toBe(false);
    expect(
      browserPasswordCommandSchema.safeParse({
        ...command,
        payload: { ...command.payload, source: { ...source(), actor: _actor } },
      }).success,
    ).toBe(false);
  });
  it.each(['version', 'kind'] as const)('refuses selected source %s mismatch before a write', (change) => {
    const command = prepareCommand(true);
    const selected = command.payload.source as Extract<BrowserPasswordSource, { state: 'selected' }>;
    selected.actor =
      change === 'version'
        ? { ...selected.actor, version: 6 }
        : { version: 7, credential: { kind: 'canonical-token', token: opaque } };
    expect(browserPasswordCommandSchema.safeParse(command).success).toBe(false);
  });
  it('keeps credential lifetime independent of the unchanged, shorter binding deadline', () => {
    const plan = preparation();
    expect(Date.parse(plan.credentialExpiresAt)).toBeGreaterThan(Date.parse(plan.browserCursor.bindingExpiresAt));
    expect(browserPasswordPreparationSchema.parse(plan)).toEqual(plan);
  });
  it('freezes raw verifier time while the actual candidate uses epoch seconds', () => {
    const plan = preparation();
    expect(browserPasswordPreparationSchema.parse(plan).passwordVerifiedAt).toBe(verifiedAt);
    expect(plan.credentialProof.authenticatedAt).toBe(authenticatedAt);
  });
  it.each([
    'raw-clock',
    'encode-clock',
    'expiry-rounding',
    'expiry-refresh',
    'future-verifier',
    'stale-verifier',
  ] as const)('refuses %s freshness or lifetime drift', (change) => {
    const plan = preparation();
    if (change === 'raw-clock') plan.credentialProof.authenticatedAt = verifiedAt;
    if (change === 'encode-clock') plan.credentialProof.authenticatedAt = plan.preparedAt;
    if (change === 'expiry-rounding')
      plan.credentialExpiresAt = new Date(
        Date.parse(verifiedAt) + BROWSER_PASSWORD_CREDENTIAL_SECONDS * 1_000,
      ).toISOString();
    if (change === 'expiry-refresh')
      plan.credentialExpiresAt = new Date(Date.parse(plan.credentialExpiresAt) + 1_000).toISOString();
    if (change === 'future-verifier') plan.passwordVerifiedAt = new Date(preparedAt + 1).toISOString();
    if (change === 'stale-verifier') plan.passwordVerifiedAt = new Date(preparedAt - 60_001).toISOString();
    expect(browserPasswordPreparationSchema.safeParse(plan).success).toBe(false);
  });
  it.each(['binding', 'version', 'expiry', 'source-revision', 'prepared-revision'] as const)(
    'refuses %s cursor/revision drift',
    (change) => {
      const plan = preparation();
      if (change === 'binding') plan.futureBrowserCursor.bindingId = 'a'.repeat(64);
      if (change === 'version') plan.futureBrowserCursor.version = 9;
      if (change === 'expiry') plan.futureBrowserCursor.bindingExpiresAt = plan.credentialExpiresAt;
      if (change === 'source-revision') plan.sourceIntentRevision = plan.intentRevision;
      if (change === 'prepared-revision') plan.intentRevision = 4;
      expect(browserPasswordPreparationSchema.safeParse(plan).success).toBe(false);
    },
  );
  it.each(['deadline', 'closed-window', 'ack-slide', 'binding-expired', 'source-expired'] as const)(
    'refuses %s deadline metadata',
    (change) => {
      const plan = preparation('legacy-jwe', true);
      if (change === 'deadline') plan.expiresAt = new Date(preparedAt + 60_001).toISOString();
      if (change === 'closed-window') plan.expiresAt = plan.preparedAt;
      if (change === 'ack-slide') plan.acknowledgeUntil = new Date(preparedAt + 300_001).toISOString();
      if (change === 'binding-expired') {
        plan.browserCursor.bindingExpiresAt = plan.preparedAt;
        plan.futureBrowserCursor.bindingExpiresAt = plan.preparedAt;
      }
      if (change === 'source-expired' && plan.source.state === 'selected') plan.source.expiresAt = plan.preparedAt;
      expect(browserPasswordPreparationSchema.safeParse(plan).success).toBe(false);
    },
  );
  it('bounds preparation by the actual source expiry without shortening the fixed ACK window', () => {
    const plan = preparation('legacy-jwe', true);
    if (plan.source.state !== 'selected') throw new Error('Fixture source mismatch');
    plan.source.expiresAt = new Date(preparedAt + 10_000).toISOString();
    expect(browserPasswordPreparationSchema.safeParse(plan).success).toBe(false);
    plan.expiresAt = plan.source.expiresAt;
    expect(browserPasswordPreparationSchema.parse(plan).acknowledgeUntil).toBe(
      new Date(preparedAt + 300_000).toISOString(),
    );
  });
  it.each(['legacy-jwe', 'canonical-token'] as const)(
    'validates all bound %s commands with exact actor and candidate kind',
    (kind) => {
      for (const operation of ['finalize', 'acknowledge', 'abort'] as const)
        for (const selected of [false, true])
          expect(browserPasswordCommandSchema.parse(boundCommand(operation, selected, kind))).toEqual(
            boundCommand(operation, selected, kind),
          );
    },
  );
  it.each(['source-state', 'source-version', 'candidate-kind'] as const)('refuses bound %s substitution', (change) => {
    const command = boundCommand();
    if (change === 'source-state') command.payload.source = source(true);
    if (change === 'source-version') command.payload.source.expectedVersion = 6;
    if (change === 'candidate-kind') command.payload.candidate = { kind: 'canonical-token', token: opaque };
    expect(browserPasswordCommandSchema.safeParse(command).success).toBe(false);
  });
  it('does not permit a newly compared password to reuse the old selected SID', () => {
    const plan = preparation('legacy-jwe', true);
    if (plan.source.state !== 'selected') throw new Error('Fixture source mismatch');
    plan.credentialProof.authSessionId = plan.source.credentialProof.authSessionId;
    expect(browserPasswordPreparationSchema.safeParse(plan).success).toBe(false);
  });
  it('does not authorize unverified password login, while allowing bounded abort', () => {
    for (const operation of ['finalize', 'acknowledge', 'abort'] as const) {
      const command = boundCommand(operation);
      command.payload.preparation.verification.verified = false;
      expect(browserPasswordCommandSchema.safeParse(command).success).toBe(operation === 'abort');
    }
  });
  it.each(['password', 'email', 'provider', 'userId', 'returnUrl'] as const)(
    'rejects injected %s at private frozen/command boundaries',
    (field) => {
      expect(browserPasswordPreparationSchema.safeParse({ ...preparation(), [field]: 'untrusted' }).success).toBe(
        false,
      );
      const command = boundCommand();
      expect(
        browserPasswordCommandSchema.safeParse({ ...command, payload: { ...command.payload, [field]: 'untrusted' } })
          .success,
      ).toBe(false);
    },
  );
  it.each(['legacy-jwe', 'canonical-token'] as const)('accepts only the %s prepared namespace', (kind) => {
    const reply = preparedReply(kind);
    expect(browserPasswordReplySchema.parse(reply)).toEqual(reply);
    expect(
      browserPasswordReplySchema.safeParse({ ...reply, proposedCanonicalToken: kind === 'legacy-jwe' ? opaque : null })
        .success,
    ).toBe(false);
    expect(browserPasswordReplySchema.safeParse({ ...reply, user: { ...reply.user, id: 'other-UID' } }).success).toBe(
      false,
    );
  });
  it('does not admit null, inherited or refreshed authentication evidence for the new credential', () => {
    for (const credentialProof of [
      { ...preparation().credentialProof, authenticatedAt: null },
      { ...preparation().credentialProof, linkGuarded: false },
      { ...preparation().credentialProof, requiresAccountCutoff: true },
    ])
      expect(browserPasswordPreparationSchema.safeParse({ ...preparation(), credentialProof }).success).toBe(false);
  });
  it('strictly correlates completed credential clocks and finite response status', () => {
    const plan = preparation();
    const completed = {
      browserPasswordProtocolVersion: 1,
      requestId,
      operation: 'acknowledge',
      outcome: 'completed',
      cursor: plan.futureBrowserCursor,
      candidateCredentialHash: 'a'.repeat(64),
      credentialProof: plan.credentialProof,
      credentialExpiresAt: plan.credentialExpiresAt,
    };
    expect(browserPasswordReplySchema.parse(completed)).toEqual(completed);
    expect(
      browserPasswordReplySchema.safeParse({
        ...completed,
        credentialExpiresAt: new Date(Date.parse(plan.credentialExpiresAt) + 1_000).toISOString(),
      }).success,
    ).toBe(false);
    expect(
      browserPasswordReplySchema.safeParse({
        ...completed,
        credentialProof: { ...plan.credentialProof, authenticatedAt: verifiedAt },
      }).success,
    ).toBe(false);
    expect(browserPasswordReplyStatus(browserPasswordReplySchema.parse(completed))).toBe(200);
    for (const [outcome, expected] of [
      ['invalid_credentials', 401],
      ['denied', 401],
      ['conflict', 409],
      ['unavailable', 503],
    ] as const)
      expect(
        browserPasswordReplyStatus(
          browserPasswordReplySchema.parse({
            browserPasswordProtocolVersion: 1,
            requestId,
            operation: 'prepare',
            outcome,
          }),
        ),
      ).toBe(expected);
  });
});
