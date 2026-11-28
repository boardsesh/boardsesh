/// <reference types="node" />
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RESOLVE_BOARD_FOR_UUID } from '../../packages/shared/graphql/src/operations/board-presence';
import { recordMobileSmokeQaFixtures, type RecordSmokeQaOptions } from '../record-mobile-smoke-qa-fixtures';
import { requiredSmokeQaRequests } from '../import-mobile-smoke-qa-fixtures';
import { emptyManifest, graphqlFixtureKey } from '../lib/screenshot-fixtures';
import { snapshotHash } from '../lib/screenshot-fixture-snapshot';

const UPSTREAM = 'https://ws.boardsesh.com';
const USER_ID = 'fbb773f8-5bec-473e-8216-e34ca55b073b';
const EMAIL = 'test@boardsesh.com';
const PASSWORD = 'live-password-never-exported';
const JWT = `header.${Buffer.from(JSON.stringify({ sub: USER_ID })).toString('base64url')}.live-signature`;
const REFRESH_TOKEN = 'live-refresh-token-never-exported';
let directory: string;
let options: RecordSmokeQaOptions;
let server: Server;
let subject: string;
let corruptResponse: boolean;
let requests: Array<{ path: string; body: Record<string, unknown> }>;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'fixed-smoke-recording-test-'));
  const base = emptyManifest({
    recordedAt: '2026-11-22T00:00:00Z',
    frozenNow: '2026-11-22T00:00:01Z',
    upstream: UPSTREAM,
    accountUserId: USER_ID,
    accountEmail: EMAIL,
    flow: 'help',
  });
  const identity = {
    operationName: 'ResolveBoardForUuid',
    query: RESOLVE_BOARD_FOR_UUID,
    variables: { boardUuid: 'dcb443be-aaea-4637-8bf8-b20cbe031192' },
  };
  const key = graphqlFixtureKey(identity, (text) => snapshotHash(Buffer.from(text)));
  const file = `graphql/ResolveBoardForUuid/${key.variablesHash.slice(0, 16)}.json`;
  base.graphql.push({ ...key, file });
  const fixture = {
    formatVersion: 1,
    ...identity,
    ...key,
    response: { data: { resolveBoardForUuid: { boardId: 4, boardType: 'kilter' } } },
    status: 200,
    recordedAt: base.recordedAt,
    upstream: UPSTREAM,
  };
  const baseArchive = gzipSync(
    JSON.stringify({
      version: 1,
      files: {
        'manifest.json': Buffer.from(JSON.stringify(base)).toString('base64'),
        [file]: Buffer.from(JSON.stringify(fixture)).toString('base64'),
      },
    }),
  );
  options = {
    reference: {
      version: 1,
      url: 'https://fixtures.example.com/base.json.gz',
      sha256: snapshotHash(baseArchive),
      bytes: baseArchive.length,
      files: 2,
    },
    baseArchive,
    outputDirectory: join(directory, 'recording'),
    email: EMAIL,
    password: PASSWORD,
  };
  subject = USER_ID;
  corruptResponse = false;
  requests = [];
  server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      requests.push({ path: request.url!, body: parsed });
      response.setHeader('content-type', 'application/json');
      const document = requiredSmokeQaRequests(USER_ID).find((query) => query.operationName === parsed.operationName);
      response.end(
        JSON.stringify(
          request.url === '/auth/native/credentials'
            ? {
                jwt:
                  subject === USER_ID
                    ? JWT
                    : `header.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.foreign`,
                refreshToken: REFRESH_TOKEN,
              }
            : corruptResponse
              ? { errors: [{ message: JWT }] }
              : document?.response,
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local server');
  const origin = `http://127.0.0.1:${address.port}`;
  const originalFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    return originalFetch(url.startsWith(UPSTREAM) ? url.replace(UPSTREAM, origin) : input, init);
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  rmSync(directory, { recursive: true, force: true });
});

describe('fixed required smoke QA recorder', () => {
  it('authenticates the pinned account then records only both exact queries without credential artifacts', async () => {
    const proof = await recordMobileSmokeQaFixtures(options);
    expect(requests).toEqual([
      { path: '/auth/native/credentials', body: { email: EMAIL, password: PASSWORD } },
      ...requiredSmokeQaRequests(USER_ID).map(({ operationName, query, variables }) => ({
        path: '/graphql',
        body: { operationName, query, variables },
      })),
    ]);
    expect(proof.sourceFlow).toBe('smoke-fixtures');
    expect(proof.addedGraphqlFiles).toHaveLength(2);
    expect(proof.fullNativeReplayRequired).toBe(true);
    const source = JSON.parse(readFileSync(join(options.outputDirectory, 'manifest.json'), 'utf8')) as {
      graphql: Array<{ file: string }>;
      static: unknown[];
    };
    expect(source.graphql).toHaveLength(2);
    expect(source.static).toHaveLength(0);
    const artifacts = source.graphql
      .map((entry) => readFileSync(join(options.outputDirectory, entry.file), 'utf8'))
      .join('\n');
    for (const secret of [PASSWORD, JWT, REFRESH_TOKEN]) expect(artifacts).not.toContain(secret);
  });

  it('makes no GraphQL read when authentication identifies a different account', async () => {
    subject = 'foreign';
    await expect(recordMobileSmokeQaFixtures(options)).rejects.toThrow('Authenticate the pinned screenshot account');
    expect(requests.map((request) => request.path)).toEqual(['/auth/native/credentials']);
  });

  it('rejects a wrong configured account before any network request', async () => {
    await expect(recordMobileSmokeQaFixtures({ ...options, email: 'other@example.com' })).rejects.toThrow(
      'Verify the pinned screenshot account',
    );
    expect(requests).toEqual([]);
  });

  it('stops on an unsafe upstream error and withholds response details', async () => {
    corruptResponse = true;
    let failure: unknown;
    try {
      await recordMobileSmokeQaFixtures(options);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    for (const secret of [PASSWORD, JWT, REFRESH_TOKEN]) expect(String(failure)).not.toContain(secret);
    expect(requests).toHaveLength(2);
  });

  it('refuses to overwrite an existing recording directory', async () => {
    mkdirSync(options.outputDirectory);
    await expect(recordMobileSmokeQaFixtures(options)).rejects.toThrow();
    expect(requests).toEqual([]);
  });
});
