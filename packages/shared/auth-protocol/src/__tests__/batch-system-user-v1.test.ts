import { describe, expect, it } from 'vite-plus/test';
import {
  AUTH_PROTOCOL_VERSION,
  BATCH_SYSTEM_USER_COMMAND_PATH,
  batchSystemUserCommandSchema,
  batchSystemUserReplySchema,
  batchSystemUserReplyStatus,
  currentStoreBatchSystemUsersMode,
} from '../index';

const command = {
  protocolVersion: 1,
  operation: 'ensure',
  requestId: '3b7f6904-5cda-4344-aec2-d855b338c7ab',
  issuedAt: 1_793_890_000_000,
  payload: { runId: 'b6a0c23f-ebc2-47a1-a583-6195cfb6c634', attemptToken: '92c24f85-bc7e-408b-b80e-c4688250cd4f' },
};

describe('private batch system-user v1 wire contract', () => {
  it('keeps the existing human protocol version separate', () => {
    expect(AUTH_PROTOCOL_VERSION).toBe(2);
    expect(BATCH_SYSTEM_USER_COMMAND_PATH).toBe('/api/internal/auth/current-store/batch-system-users/v1/ensure');
    expect(batchSystemUserCommandSchema.parse(command)).toEqual(command);
  });
  it.each(['userId', 'email', 'kind', 'family', 'role', 'authority', 'projectionId'])(
    'rejects caller-supplied %s at either level',
    (field) => {
      expect(batchSystemUserCommandSchema.safeParse({ ...command, [field]: 'untrusted' }).success).toBe(false);
      expect(
        batchSystemUserCommandSchema.safeParse({ ...command, payload: { ...command.payload, [field]: 'untrusted' } })
          .success,
      ).toBe(false);
    },
  );
  it.each([0, 2, '1', null])('rejects a different or mistyped version %j', (protocolVersion) => {
    expect(batchSystemUserCommandSchema.safeParse({ ...command, protocolVersion }).success).toBe(false);
  });
  it.each(['requestId', 'runId', 'attemptToken'])('requires a canonical actual %s', (field) => {
    for (const invalid of ['unknown', '', '3B7F6904-5CDA-4344-AEC2-D855B338C7AB']) {
      const contents =
        field === 'requestId'
          ? { ...command, requestId: invalid }
          : { ...command, payload: { ...command.payload, [field]: invalid } };
      expect(batchSystemUserCommandSchema.safeParse(contents).success).toBe(false);
    }
  });
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, 'now', null])('rejects invalid issuedAt %j', (issuedAt) => {
    expect(batchSystemUserCommandSchema.safeParse({ ...command, issuedAt }).success).toBe(false);
  });
  it('requires actual run and attempt fields and rejects password operations', () => {
    expect(
      batchSystemUserCommandSchema.safeParse({ ...command, payload: { runId: command.payload.runId } }).success,
    ).toBe(false);
    expect(batchSystemUserCommandSchema.safeParse({ ...command, operation: 'password' }).success).toBe(false);
  });
  it('returns no credential, identity or provider fields', () => {
    const reply = { protocolVersion: 1, operation: 'ensure', requestId: command.requestId, outcome: 'ensured' };
    expect(batchSystemUserReplyStatus(batchSystemUserReplySchema.parse(reply))).toBe(200);
    for (const field of ['userId', 'email', 'jwt', 'refreshToken', 'sessionId', 'password', 'provider'])
      expect(batchSystemUserReplySchema.safeParse({ ...reply, [field]: 'untrusted' }).success).toBe(false);
    expect(batchSystemUserReplySchema.safeParse({ ...reply, outcome: 'created' }).success).toBe(false);
  });
  it.each([
    ['invalid_request', 400],
    ['request_expired', 400],
    ['unauthorized', 401],
    ['attempt_lost', 409],
    ['replayed_request', 409],
    ['unavailable', 503],
  ] as const)('has a bounded %s rejection and status', (code, status) => {
    const reply = batchSystemUserReplySchema.parse({
      protocolVersion: 1,
      operation: 'ensure',
      requestId: command.requestId,
      outcome: 'rejected',
      code,
    });
    expect(batchSystemUserReplyStatus(reply)).toBe(status);
    expect(batchSystemUserReplySchema.safeParse({ ...reply, cause: 'private provider response' }).success).toBe(false);
  });
  it('defaults independently and rejects ambiguous configuration', () => {
    for (const mode of [undefined, '', 'legacy'])
      expect(
        currentStoreBatchSystemUsersMode({
          CURRENT_STORE_BATCH_SYSTEM_USERS_MODE: mode,
          CURRENT_STORE_WEB_AUTH_MODE: 'backend-staging',
        }),
      ).toBe('legacy');
    expect(currentStoreBatchSystemUsersMode({ CURRENT_STORE_BATCH_SYSTEM_USERS_MODE: 'backend-staging' })).toBe(
      'backend-staging',
    );
    for (const mode of ['reserved-staging', ' backend-staging', 'BACKEND-STAGING'])
      expect(() => currentStoreBatchSystemUsersMode({ CURRENT_STORE_BATCH_SYSTEM_USERS_MODE: mode })).toThrow();
  });
});
