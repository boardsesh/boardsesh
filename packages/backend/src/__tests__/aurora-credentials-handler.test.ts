import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { FOREIGN_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR } from '@boardsesh/shared-schema/sync-error-codes';

const saveAuroraCredentialMock = vi.fn();
const getAuroraCredentialStatusesMock = vi.fn();
const validateTokenMock = vi.fn();

// Mirror the real DuplicateBoardLinkError so the handler's `instanceof` → 409
// mapping works against the mocked service module.
const DuplicateBoardLinkErrorMock = class DuplicateBoardLinkError extends Error {
  code = 'account_already_linked';
  constructor(message = 'This board account is already linked to another Boardsesh member.') {
    super(message);
    this.name = 'DuplicateBoardLinkError';
  }
};

vi.mock('../services/aurora-credentials', () => ({
  DuplicateBoardLinkError: DuplicateBoardLinkErrorMock,
  saveAuroraCredential: saveAuroraCredentialMock,
  getAuroraCredentialStatuses: getAuroraCredentialStatusesMock,
  getAuroraUnsyncedCounts: vi.fn(),
  deleteAuroraCredential: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  validateToken: validateTokenMock,
}));

vi.mock('../utils/logger', () => ({
  logger: {
    warn: vi.fn(),
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

let handlers: typeof import('../handlers/aurora-credentials');

describe('Aurora credentials REST handler', () => {
  beforeEach(async () => {
    vi.resetModules();
    saveAuroraCredentialMock.mockReset();
    getAuroraCredentialStatusesMock.mockReset();
    validateTokenMock.mockReset();
    handlers = await import('../handlers/aurora-credentials');
  });

  it('GET preserves the ownership-state sync_error code for clients to localise', async () => {
    validateTokenMock.mockResolvedValue({ userId: 'foreign-owner-user' });
    getAuroraCredentialStatusesMock.mockResolvedValue([
      {
        boardType: 'tension',
        auroraUsername: 'climber',
        auroraUserId: 42,
        lastSyncAt: '2026-07-31T00:00:00.000Z',
        syncStatus: 'active',
        syncError: FOREIGN_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const request = makeRequest({ method: 'GET', headers: { authorization: 'Bearer token' } });
    const response = makeResponse();

    await handlers.handleAuroraCredentials(request as never, response as never);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      credentials: [{ syncError: FOREIGN_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR }],
    });
  });

  it('POST returns 409 + code when the account is already linked to another user', async () => {
    validateTokenMock.mockResolvedValue({ userId: 'dup-user' });
    saveAuroraCredentialMock.mockRejectedValue(new DuplicateBoardLinkErrorMock());
    const request = makeRequest({
      method: 'POST',
      headers: { authorization: 'Bearer token' },
      body: JSON.stringify({ boardType: 'tension', username: 'climber', password: 'secret' }),
    });
    const response = makeResponse();

    await handlers.handleAuroraCredentials(request as never, response as never);

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({ code: 'account_already_linked' });
  });

  it('POST returns 200 on a successful link', async () => {
    validateTokenMock.mockResolvedValue({ userId: 'ok-user' });
    saveAuroraCredentialMock.mockResolvedValue({
      boardType: 'tension',
      auroraUsername: 'climber',
      auroraUserId: 42,
      lastSyncAt: null,
      syncStatus: 'pending',
      syncError: null,
      createdAt: new Date().toISOString(),
    });
    const request = makeRequest({
      method: 'POST',
      headers: { authorization: 'Bearer token' },
      body: JSON.stringify({ boardType: 'tension', username: 'climber', password: 'secret' }),
    });
    const response = makeResponse();

    await handlers.handleAuroraCredentials(request as never, response as never);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ success: true });
  });
});
