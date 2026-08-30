// @ts-nocheck — __tests__ is excluded from tsconfig.json; Vitest checks this file.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { afterAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { hash } from 'bcryptjs';
import { inArray } from 'drizzle-orm';
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
const oversizedUserIds = Array.from({ length: 9 }, () => crypto.randomUUID());
const allTestUserIds = [testUserId, ...oversizedUserIds];
const legacyTestEmail = `Legacy.Native.Login.${testUserId}@example.com`;
const oversizedTestEmail = `Oversized.Native.Group.${oversizedUserIds[0]}@example.com`;

describe('native credentials auth against Postgres', () => {
  beforeEach(() => {
    __resetNativeAuthStateForTests();
  });

  afterAll(async () => {
    await db.delete(users).where(inArray(users.id, allTestUserIds));
  });

  it('authenticates a lower-case submission against a legacy mixed-case email row', async () => {
    await db.insert(users).values({
      id: testUserId,
      email: legacyTestEmail,
      name: 'Legacy Native Login',
    });
    await db.insert(userCredentials).values({
      userId: testUserId,
      passwordHash: await hash('mixed-case-password', 10),
    });

    const request = makeRequest({
      email: legacyTestEmail.toLowerCase(),
      password: 'mixed-case-password',
    });
    const response = makeResponse();

    await handleNativeAuthCredentials(request as unknown as IncomingMessage, response as unknown as ServerResponse);

    expect(response.statusCode).toBe(200);
    expect(parseJwtSubject(response)).toBe(testUserId);
  });

  it('rejects a case-insensitive group above the credential candidate limit', async () => {
    const passwordHash = await hash('oversized-group-password', 10);
    await db.insert(users).values(
      oversizedUserIds.map((id, index) => ({
        id,
        email: oversizedTestEmail,
        name: `Oversized Native Login ${index}`,
      })),
    );
    await db.insert(userCredentials).values(
      oversizedUserIds.map((userId) => ({
        userId,
        passwordHash,
      })),
    );

    const request = makeRequest({
      email: oversizedTestEmail.toLowerCase(),
      password: 'oversized-group-password',
    });
    const response = makeResponse();

    await handleNativeAuthCredentials(request as unknown as IncomingMessage, response as unknown as ServerResponse);

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: 'Invalid email or password' });
  });
});
