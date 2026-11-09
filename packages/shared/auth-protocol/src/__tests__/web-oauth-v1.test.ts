import { describe, expect, it } from 'vitest';
import {
  AUTH_COMMAND_PATHS,
  AUTH_PROTOCOL_VERSION,
  authCommandSchema,
  authCommandReplySchema,
  WEB_OAUTH_PROTOCOL_VERSION,
  WEB_OAUTH_PATH_PREFIX,
  WEB_OAUTH_COMMAND_PATHS,
  WEB_OAUTH_FIELD_LIMITS,
  webOAuthCommandSchema,
  webOAuthIntentCommandSchema,
  webOAuthResolveCommandSchema,
  webOAuthReplySchema,
  webOAuthIntentReplySchema,
  webOAuthResolveReplySchema,
  webOAuthProtocolRejectionSchema,
  webOAuthProtocolRejectionStatus,
  webOAuthReplyStatus,
} from '../index';

const requestId = 'e363934b-b7ba-41ba-a279-52185daa100e';
const timestamp = '2026-11-05T10:00:00.000Z';
const flow = 'a'.repeat(64);
const metadata = { webOAuthProtocolVersion: 1, requestId };
const intent = {
  ...metadata,
  operation: 'intent',
  issuedAt: timestamp,
  payload: { provider: 'google', flow, actorCookie: null },
};
const resolve = {
  ...intent,
  operation: 'resolve',
  payload: { ...intent.payload, subject: ' Provider-SUBJECT ', email: null, name: null, image: null },
};
const recorded = { ...metadata, operation: 'intent', outcome: 'recorded', flow, expiresAt: timestamp };
const resolved = {
  ...metadata,
  operation: 'resolve',
  outcome: 'resolved',
  user: {
    id: 'stable-existing-user',
    email: ' Legacy.Mixed+tag@Example.com ',
    name: null,
    image: null,
    emailVerified: null,
    createdAt: timestamp,
  },
  createdUser: false,
  account: { provider: 'google', providerAccountId: resolve.payload.subject },
};

describe('independent web OAuth identity v1 contract', () => {
  it('uses a distinct namespace and leaves all six V2 paths and version unchanged', () => {
    expect(WEB_OAUTH_PROTOCOL_VERSION).toBe(1);
    expect(WEB_OAUTH_PATH_PREFIX).toBe('/api/internal/auth/current-store/web-oauth/v1');
    expect(WEB_OAUTH_COMMAND_PATHS).toEqual({
      intent: `${WEB_OAUTH_PATH_PREFIX}/intent`,
      resolve: `${WEB_OAUTH_PATH_PREFIX}/resolve`,
    });
    expect(AUTH_PROTOCOL_VERSION).toBe(2);
    expect(Object.keys(AUTH_COMMAND_PATHS)).toEqual([
      'register',
      'password',
      'verify-email',
      'resend-verification',
      'forgot-password',
      'reset-password',
    ]);
    expect(authCommandSchema.safeParse(intent).success).toBe(false);
    expect(authCommandSchema.safeParse(resolve).success).toBe(false);
    expect(authCommandReplySchema.safeParse(resolved).success).toBe(false);
    expect(
      webOAuthCommandSchema.safeParse({
        protocolVersion: 2,
        operation: 'password',
        requestId,
        issuedAt: 0,
        payload: {},
      }).success,
    ).toBe(false);
  });

  it.each(['google', 'apple', 'facebook'])('admits only the configured provider family: %s', (provider) => {
    expect(
      webOAuthIntentCommandSchema.parse({ ...intent, payload: { ...intent.payload, provider } }).payload.provider,
    ).toBe(provider);
    expect(
      webOAuthResolveCommandSchema.safeParse({ ...resolve, payload: { ...resolve.payload, provider } }).success,
    ).toBe(true);
  });

  it.each(['credentials', 'native-oauth', 'Google', 'unknown'])(
    'rejects another provider identifier: %s',
    (provider) => {
      expect(webOAuthCommandSchema.safeParse({ ...intent, payload: { ...intent.payload, provider } }).success).toBe(
        false,
      );
    },
  );

  it('requires explicit actor absence or the exact raw cookie without decoding or trimming it', () => {
    const actorCookie = ' raw.legacy.encrypted.cookie ';
    expect(webOAuthIntentCommandSchema.parse(intent).payload.actorCookie).toBeNull();
    expect(
      webOAuthIntentCommandSchema.parse({ ...intent, payload: { ...intent.payload, actorCookie } }).payload.actorCookie,
    ).toBe(actorCookie);
    for (const invalidActor of [undefined, '', false, 0, {}]) {
      expect(
        webOAuthCommandSchema.safeParse({ ...intent, payload: { ...intent.payload, actorCookie: invalidActor } })
          .success,
      ).toBe(false);
    }
  });

  it('requires the subject and nullable profile fields while preserving their exact bytes', () => {
    const payload = {
      ...resolve.payload,
      email: ' Mixed+tag@Example.com ',
      name: '  A climber  ',
      image: ' raw-provider-image ',
    };
    expect(webOAuthResolveCommandSchema.parse({ ...resolve, payload }).payload).toEqual(payload);
    for (const field of ['subject', 'email', 'name', 'image']) {
      expect(
        webOAuthResolveCommandSchema.safeParse({ ...resolve, payload: { ...payload, [field]: undefined } }).success,
      ).toBe(false);
    }
    expect(webOAuthResolveCommandSchema.safeParse({ ...resolve, payload: { ...payload, subject: '' } }).success).toBe(
      false,
    );
  });

  it('allows returning subjects with no email and the existing long-name fixture', () => {
    const command = webOAuthResolveCommandSchema.parse({
      ...resolve,
      payload: { ...resolve.payload, name: 'N'.repeat(3500) },
    });
    expect(command.payload.email).toBeNull();
    expect(command.payload.name?.length).toBe(3500);
  });

  it.each([
    ['subject', WEB_OAUTH_FIELD_LIMITS.subject],
    ['actorCookie', WEB_OAUTH_FIELD_LIMITS.actorCookie],
    ['email', WEB_OAUTH_FIELD_LIMITS.email],
    ['name', WEB_OAUTH_FIELD_LIMITS.name],
    ['image', WEB_OAUTH_FIELD_LIMITS.image],
  ] as const)('bounds the %s field without truncation', (field, limit) => {
    const payload = { ...resolve.payload, [field]: 'A'.repeat(limit) };
    expect(webOAuthResolveCommandSchema.parse({ ...resolve, payload }).payload[field]?.length).toBe(limit);
    expect(
      webOAuthResolveCommandSchema.safeParse({ ...resolve, payload: { ...payload, [field]: 'A'.repeat(limit + 1) } })
        .success,
    ).toBe(false);
  });

  it('requires UUIDv4 request IDs, UTC ISO times and lowercase complete SHA256 flow digests', () => {
    for (const invalidId of ['', 'not-a-uuid', 'e363934b-b7ba-11ba-a279-52185daa100e']) {
      expect(webOAuthCommandSchema.safeParse({ ...intent, requestId: invalidId }).success).toBe(false);
    }
    for (const issuedAt of [0, '2026-11-05', '2026-11-05T10:00:00+01:00']) {
      expect(webOAuthCommandSchema.safeParse({ ...intent, issuedAt }).success).toBe(false);
    }
    for (const invalidFlow of [flow.toUpperCase(), 'a'.repeat(63), 'g'.repeat(64)]) {
      expect(
        webOAuthCommandSchema.safeParse({ ...intent, payload: { ...intent.payload, flow: invalidFlow } }).success,
      ).toBe(false);
    }
  });

  it('rejects wrong versions, cross-operation shapes and caller-selected credential authority', () => {
    for (const version of [undefined, 0, 2, '1']) {
      expect(webOAuthCommandSchema.safeParse({ ...intent, webOAuthProtocolVersion: version }).success).toBe(false);
    }
    expect(webOAuthIntentCommandSchema.safeParse(resolve).success).toBe(false);
    expect(webOAuthResolveCommandSchema.safeParse(intent).success).toBe(false);
    for (const field of ['userId', 'authSessionId', 'sourceProof', 'originalAuthenticatedAt', 'protocolVersion']) {
      expect(webOAuthCommandSchema.safeParse({ ...resolve, [field]: 'forged' }).success).toBe(false);
      expect(
        webOAuthCommandSchema.safeParse({ ...resolve, payload: { ...resolve.payload, [field]: 'forged' } }).success,
      ).toBe(false);
    }
  });

  it('keeps canonical response fields and verified timestamps exact without issuing authority', () => {
    expect(webOAuthResolveReplySchema.parse(resolved)).toEqual(resolved);
    const verified = { ...resolved, user: { ...resolved.user, emailVerified: timestamp } };
    expect(webOAuthResolveReplySchema.parse(verified)).toEqual(verified);
    expect(webOAuthReplyStatus(webOAuthResolveReplySchema.parse(resolved))).toBe(200);
    for (const field of ['sourceProof', 'authSessionId', 'jwt', 'refreshToken', 'originalAuthenticatedAt']) {
      expect(webOAuthResolveReplySchema.safeParse({ ...resolved, [field]: 'private' }).success).toBe(false);
      expect(
        webOAuthResolveReplySchema.safeParse({ ...resolved, user: { ...resolved.user, [field]: 'private' } }).success,
      ).toBe(false);
    }
    expect(
      webOAuthResolveReplySchema.safeParse({ ...resolved, account: { ...resolved.account, access_token: 'private' } })
        .success,
    ).toBe(false);
  });

  it('requires exact intent reply binding fields and operation-specific reply shapes', () => {
    expect(webOAuthIntentReplySchema.parse(recorded)).toEqual(recorded);
    expect(webOAuthReplyStatus(webOAuthIntentReplySchema.parse(recorded))).toBe(200);
    expect(webOAuthIntentReplySchema.safeParse(resolved).success).toBe(false);
    expect(webOAuthResolveReplySchema.safeParse(recorded).success).toBe(false);
    for (const field of ['flow', 'expiresAt', 'requestId']) {
      expect(webOAuthIntentReplySchema.safeParse({ ...recorded, [field]: undefined }).success).toBe(false);
    }
    expect(webOAuthReplySchema.safeParse({ ...recorded, expiresAt: 'not-an-expiry' }).success).toBe(false);
    expect(
      webOAuthReplySchema.safeParse({ ...resolved, user: { ...resolved.user, createdAt: timestamp, emailVerified: 0 } })
        .success,
    ).toBe(false);
  });

  it.each(['intent', 'resolve'])('keeps generic denials finite and correlated for %s', (operation) => {
    for (const code of ['identity_unavailable', 'replayed']) {
      const reply = webOAuthReplySchema.parse({ ...metadata, operation, outcome: 'denied', code });
      expect(webOAuthReplyStatus(reply)).toBe(409);
      expect(webOAuthReplySchema.safeParse({ ...reply, message: 'private provider or account detail' }).success).toBe(
        false,
      );
    }
    expect(
      webOAuthReplySchema.safeParse({ ...metadata, operation, outcome: 'denied', code: 'owner_email' }).success,
    ).toBe(false);
  });

  it.each(['email_conflict', 'email_required'])('lets only resolve carry the %s denial', (code) => {
    const reply = webOAuthReplySchema.parse({ ...metadata, operation: 'resolve', outcome: 'denied', code });
    expect(webOAuthReplyStatus(reply)).toBe(409);
    expect(webOAuthReplySchema.safeParse({ ...metadata, operation: 'intent', outcome: 'denied', code }).success).toBe(
      false,
    );
  });

  it.each([
    ['invalid_request', 400],
    ['expired_request', 400],
    ['unauthorized', 401],
    ['disabled', 404],
    ['unavailable', 503],
  ] as const)('separates the %s transport rejection from identity denial', (error, status) => {
    const rejection = webOAuthProtocolRejectionSchema.parse({ error });
    expect(webOAuthProtocolRejectionStatus(rejection)).toBe(status);
    expect(webOAuthReplySchema.safeParse(rejection).success).toBe(false);
    expect(webOAuthProtocolRejectionSchema.safeParse({ error, detail: 'private' }).success).toBe(false);
  });
});
