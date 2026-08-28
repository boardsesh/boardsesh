// @ts-nocheck — __tests__ is excluded from tsconfig.json; Vitest checks this file.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { afterAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { hash } from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { users, userCredentials } from '@boardsesh/db/schema/auth';
import { db } from '../db/client';

process.env.NEXTAUTH_SECRET = 'test-secret-for-native-auth-credentials-integration';

const { handleNativeAuthCredentials, __resetNativeAuthStateForTests } = await import('../handlers/native-auth');

interface MockRequest extends EventEmitter {
  method?: string;
  url?: string;
  headers: Record<string, string | string[]>;
  socket: Partial<Socket>;
  destroy: () => void;
}

interface MockResponse {
  statusCode: number;
  body: string;
  headers: Record<string, unknown>;
  writeHead: (status: number, headers?: Record<string, unknown>) => void;
  end: (body?: string) => void;
  setHeader: (name: string, value: unknown) => void;
}

function makeRequest(body: unknown): MockRequest {
  const request = new EventEmitter() as MockRequest;
  request.method = 'POST';
  request.url = '/auth/native/credentials';
  request.headers = {};
  request.socket = { remoteAddress: '127.0.0.1' };
  request.destroy = () => undefined;
  setImmediate(() => {
    request.emit('data', Buffer.from(JSON.stringify(body), 'utf8'));
    request.emit('end');
  });
  return request;
}

function makeResponse(): MockResponse {
  return {
    statusCode: 0,
    body: '',
    headers: {},
    writeHead(status, headers) {
      this.statusCode = status;
      if (headers) Object.assign(this.headers, headers);
    },
    end(body) {
      if (body !== undefined) this.body = body;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
  };
}

function parseJwtSubject(response: MockResponse): unknown {
  const parsed = JSON.parse(response.body) as { jwt?: unknown };
  if (typeof parsed.jwt !== 'string') throw new Error('Expected JWT response');
  const encodedPayload = parsed.jwt.split('.')[1];
  if (!encodedPayload) throw new Error('Expected JWT payload');
  const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as { sub?: unknown };
  return payload.sub;
}

const testUserId = crypto.randomUUID();

describe('native credentials auth against Postgres', () => {
  beforeEach(() => {
    __resetNativeAuthStateForTests();
  });

  afterAll(async () => {
    await db.delete(users).where(eq(users.id, testUserId));
  });

  it('authenticates a lower-case submission against a legacy mixed-case email row', async () => {
    await db.insert(users).values({
      id: testUserId,
      email: 'Legacy.Native.Login@example.com',
      name: 'Legacy Native Login',
    });
    await db.insert(userCredentials).values({
      userId: testUserId,
      passwordHash: await hash('mixed-case-password', 10),
    });

    const request = makeRequest({
      email: 'legacy.native.login@example.com',
      password: 'mixed-case-password',
    });
    const response = makeResponse();

    await handleNativeAuthCredentials(request as unknown as IncomingMessage, response as unknown as ServerResponse);

    expect(response.statusCode).toBe(200);
    expect(parseJwtSubject(response)).toBe(testUserId);
  });
});
