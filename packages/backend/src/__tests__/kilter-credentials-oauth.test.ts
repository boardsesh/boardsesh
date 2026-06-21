import { Readable } from 'node:stream';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { encrypt } from '@boardsesh/crypto';

const exchangeAuthorizationCodeMock = vi.fn();
const verifyKeycloakTokenMock = vi.fn();
const validateTokenMock = vi.fn();
const isKilterSyncAllowedMock = vi.fn();
const saveKilterCredentialMock = vi.fn();

vi.mock('@boardsesh/kilter-sync/api', () => ({
  exchangeAuthorizationCode: exchangeAuthorizationCodeMock,
  KILTER_BOARD_TYPE: 'kilter',
  KILTER_OAUTH_AUTH_URL: 'https://kilter.example/auth',
  verifyKeycloakToken: verifyKeycloakTokenMock,
}));

vi.mock('../middleware/auth', () => ({
  validateToken: validateTokenMock,
}));

vi.mock('../services/aurora-credentials', () => ({
  isKilterSyncAllowed: isKilterSyncAllowedMock,
  saveKilterCredential: saveKilterCredentialMock,
}));

vi.mock('../redis/client', () => ({
  redisClientManager: {
    isRedisConnected: () => false,
    isRedisConfigured: () => false,
    getClients: vi.fn(),
  },
}));

type TestResponse = {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
  setHeader: (name: string, value: string | string[]) => void;
  writeHead: (statusCode: number, headers?: Record<string, string | string[]>) => void;
  end: (body?: string) => void;
};

function makeRequest(options: { method: string; headers?: Record<string, string>; body?: string }) {
  const request = Readable.from(options.body ? [options.body] : []);
  return Object.assign(request, {
    method: options.method,
    headers: options.headers ?? {},
  });
}

function makeResponse(): TestResponse {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name] = value;
    },
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = { ...this.headers, ...headers };
    },
    end(body = '') {
      this.body += body;
    },
  };
}

let oauthHandlers: typeof import('../handlers/kilter-credentials-oauth');
let credentialState: typeof import('../services/board-credential-state');

describe('Kilter credential OAuth handlers', () => {
  beforeAll(async () => {
    process.env.NEXTAUTH_SECRET = 'test-nextauth-secret';
    process.env.AURORA_CREDENTIALS_SECRET = 'test-aurora-secret';
    process.env.KILTER_OAUTH_CLIENT_ID = 'boardsesh-test';
    process.env.KILTER_OAUTH_REDIRECT_URI = 'https://ws.boardsesh.test/board-credentials/kilter/callback';

    oauthHandlers = await import('../handlers/kilter-credentials-oauth');
    credentialState = await import('../services/board-credential-state');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    isKilterSyncAllowedMock.mockReturnValue(true);
  });

  it('callback redirects with a completion token instead of saving directly', async () => {
    exchangeAuthorizationCodeMock.mockResolvedValue({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      id_token: 'id-token',
    });
    verifyKeycloakTokenMock.mockResolvedValue({ sub: 'kilter-user', preferredUsername: 'kilter-name' });

    const state = credentialState.signBoardCredentialState({ userId: 'boardsesh-user', provider: 'kilter' });
    const request = makeRequest({
      method: 'GET',
      headers: {
        cookie: [
          `kilter_oauth_state=${encodeURIComponent(state)}`,
          'kilter_oauth_verifier=verifier',
          'kilter_oauth_nonce=nonce',
        ].join('; '),
      },
    });
    const response = makeResponse();

    await oauthHandlers.handleKilterCredentialsCallback(
      request as never,
      response as never,
      new URL(
        `https://ws.boardsesh.test/board-credentials/kilter/callback?code=abc&state=${encodeURIComponent(state)}`,
      ),
    );

    expect(response.statusCode).toBe(302);
    expect(saveKilterCredentialMock).not.toHaveBeenCalled();

    const location = new URL(String(response.headers.Location));
    expect(location.searchParams.get('status')).toBe('connected');
    const completion = location.searchParams.get('completion');
    expect(completion).toBeTruthy();
    expect(credentialState.verifyBoardCredentialCompletion(completion!)).toMatchObject({
      userId: 'boardsesh-user',
      provider: 'kilter',
      kilterUserId: 'kilter-user',
      username: 'kilter-name',
    });
  });

  it('finalize rejects another Boardsesh user without consuming the completion token', async () => {
    validateTokenMock
      .mockResolvedValueOnce({ userId: 'other-user' })
      .mockResolvedValueOnce({ userId: 'boardsesh-owner' });
    const completion = credentialState.signBoardCredentialCompletion({
      userId: 'boardsesh-owner',
      provider: 'kilter',
      encryptedRefreshToken: encrypt('owner-refresh-token'),
      kilterUserId: 'owner-kilter-user',
    });
    const otherUserRequest = makeRequest({
      method: 'POST',
      headers: { authorization: 'Bearer other-user-token' },
      body: JSON.stringify({ completion }),
    });
    const otherUserResponse = makeResponse();

    await oauthHandlers.handleKilterCredentialsFinalize(otherUserRequest as never, otherUserResponse as never);

    expect(otherUserResponse.statusCode).toBe(403);
    expect(saveKilterCredentialMock).not.toHaveBeenCalled();

    const ownerRequest = makeRequest({
      method: 'POST',
      headers: { authorization: 'Bearer owner-token' },
      body: JSON.stringify({ completion }),
    });
    const ownerResponse = makeResponse();

    await oauthHandlers.handleKilterCredentialsFinalize(ownerRequest as never, ownerResponse as never);

    expect(ownerResponse.statusCode).toBe(200);
    expect(saveKilterCredentialMock).toHaveBeenCalledWith({
      userId: 'boardsesh-owner',
      refreshToken: 'owner-refresh-token',
      kilterUserId: 'owner-kilter-user',
    });
  });

  it('finalize saves the Kilter credential for the authenticated matching user', async () => {
    validateTokenMock.mockResolvedValue({ userId: 'boardsesh-user' });
    const completion = credentialState.signBoardCredentialCompletion({
      userId: 'boardsesh-user',
      provider: 'kilter',
      encryptedRefreshToken: encrypt('refresh-token'),
      kilterUserId: 'kilter-user',
      username: 'kilter-name',
    });
    const request = makeRequest({
      method: 'POST',
      headers: { authorization: 'Bearer boardsesh-token' },
      body: JSON.stringify({ completion }),
    });
    const response = makeResponse();

    await oauthHandlers.handleKilterCredentialsFinalize(request as never, response as never);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ success: true });
    expect(saveKilterCredentialMock).toHaveBeenCalledWith({
      userId: 'boardsesh-user',
      refreshToken: 'refresh-token',
      kilterUserId: 'kilter-user',
      username: 'kilter-name',
    });
  });
});
