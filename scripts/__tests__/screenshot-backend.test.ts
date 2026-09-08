/// <reference types="node" />

// End-to-end over a real socket: record against an in-test upstream, then
// replay the fixture set that produced. Everything here is a capture failure
// that is invisible in the PNGs — a miss answered as a 5xx would replace the
// screen under capture with an offline banner, a token written into a fixture
// would be a credential in git, and a fixture keyed on the wrong bytes would
// shoot the wrong data with no error at all.

import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import {
  createScreenshotBackend,
  isFixtureFileWithinDirectory,
  listFixtureFiles,
  readScreenshotFixtureManifest,
  type ScreenshotBackendServer,
} from '../lib/screenshot-backend';
import {
  FIXTURE_SIZE_NOTE_BYTES,
  RE_RECORD_COMMAND,
  findScreenshotBackendProblems,
  fixtureSizeNote,
  validateScreenshotFixtureManifest,
} from '../lib/screenshot-fixtures';

const FROZEN_NOW = '2026-09-08T09:00:00Z';
const ACCOUNT_EMAIL = 'shots@boardsesh.com';
const ACCOUNT_USER_ID = '11111111-2222-3333-4444-555555555555';
const AVATAR_BYTES = Buffer.from('fake-jpeg-bytes-for-the-avatar', 'utf8');

const base64Url = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

// A real jwt SHAPE, because the recorder reads the account's user id out of it
// and the app reads its own id out of the synthetic one replay hands back. The
// whole token and its payload segment are both things that must never reach
// disk — only the `sub` inside may.
const UPSTREAM_JWT_PAYLOAD = base64Url(JSON.stringify({ sub: ACCOUNT_USER_ID, email: ACCOUNT_EMAIL }));
const UPSTREAM_JWT = `${base64Url('{"alg":"HS256","typ":"JWT"}')}.${UPSTREAM_JWT_PAYLOAD}.upstream-signature-never-on-disk`;
const UPSTREAM_REFRESH_TOKEN = 'upstream-refresh-token-that-must-never-reach-disk';

/**
 * A local copy of `userIdFromJwt`'s parsing rules
 * (packages/mobile/src/lib/jwt-user-id.ts): exactly three dot-separated
 * segments, `sub` read out of the base64url middle one. Copied rather than
 * imported so this test fails if the replay token stops being decodable by the
 * app, not merely if it stops matching the backend's own encoder.
 */
function subjectFromJwt(token: string): string | undefined {
  const segments = token.split('.');
  if (segments.length !== 3) return undefined;
  const payload: unknown = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
  if (typeof payload !== 'object' || payload === null) return undefined;
  const subject = (payload as { sub?: unknown }).sub;
  return typeof subject === 'string' ? subject : undefined;
}

const SYNC_TICKS_QUERY =
  'query SyncTicks($cursor: SyncCursorInput) {\n  syncTicks(cursor: $cursor) {\n    documents\n  }\n}';
const SYNC_TICKS_RESPONSE = { data: { syncTicks: { documents: [{ uuid: 'tick-1' }] } } };

type UpstreamHarness = {
  server: Server;
  origin: string;
  /** Set to make the next /graphql POST answer with this instead of the canned body. */
  nextGraphqlResponse: { status: number; body: unknown } | null;
  graphqlRequests: Array<{ operationName?: string; authorization?: string }>;
  staticRequestPaths: string[];
};

async function startUpstream(): Promise<UpstreamHarness> {
  const harness: Partial<UpstreamHarness> & Pick<UpstreamHarness, 'graphqlRequests' | 'staticRequestPaths'> = {
    nextGraphqlResponse: null,
    graphqlRequests: [],
    staticRequestPaths: [],
  };

  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://upstream.local');
    if (request.method === 'POST' && requestUrl.pathname === '/graphql') {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { operationName?: string };
        harness.graphqlRequests.push({
          operationName: body.operationName,
          authorization: request.headers.authorization,
        });
        const canned = harness.nextGraphqlResponse;
        harness.nextGraphqlResponse = null;
        const status = canned?.status ?? 200;
        const payload = JSON.stringify(canned?.body ?? SYNC_TICKS_RESPONSE);
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(payload);
      });
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname.startsWith('/auth/native/')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          jwt: UPSTREAM_JWT,
          refreshToken: UPSTREAM_REFRESH_TOKEN,
          expiresAt: '2026-09-09T09:00:00.000Z',
        }),
      );
      return;
    }
    // PROD answers /static/* with a 302 to a CDN; the recorder must follow it
    // and still key by the ORIGINAL path.
    if (request.method === 'GET' && requestUrl.pathname === '/static/avatars/marco.jpg') {
      harness.staticRequestPaths.push(requestUrl.pathname + requestUrl.search);
      response.writeHead(302, { location: '/cdn/redirected-avatar.jpg' });
      response.end();
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/cdn/redirected-avatar.jpg') {
      harness.staticRequestPaths.push(requestUrl.pathname);
      response.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': AVATAR_BYTES.length });
      response.end(AVATAR_BYTES);
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{"error":"not found"}');
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });

  return Object.assign(harness as UpstreamHarness, { server, origin: `http://127.0.0.1:${port}` });
}

function stopUpstream(harness: UpstreamHarness): Promise<void> {
  return new Promise<void>((resolve) => {
    harness.server.closeAllConnections();
    harness.server.close(() => resolve());
  });
}

describe('screenshot backend', () => {
  let fixturesDir: string;
  let upstream: UpstreamHarness;
  let backend: ScreenshotBackendServer | null = null;
  let backendOrigin = '';
  let logLines: string[] = [];

  const start = async (options: { mode: 'replay' | 'record'; fresh?: boolean }): Promise<void> => {
    logLines = [];
    backend = createScreenshotBackend({
      mode: options.mode,
      fixturesDir,
      upstreamUrl: options.mode === 'record' ? upstream.origin : null,
      frozenNow: FROZEN_NOW,
      log: (line) => logLines.push(line),
      fresh: options.fresh,
      flow: 'app-store',
    });
    const port = await backend.listen(0);
    backendOrigin = `http://127.0.0.1:${port}`;
  };

  const stop = async (): Promise<void> => {
    if (!backend) return;
    await backend.close();
    backend = null;
  };

  const postGraphql = (body: unknown): Promise<Response> =>
    fetch(`${backendOrigin}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${UPSTREAM_JWT}` },
      body: JSON.stringify(body),
    });

  const hasLine = (fragment: string): boolean => logLines.some((line) => line.includes(fragment));

  beforeEach(async () => {
    fixturesDir = mkdtempSync(join(tmpdir(), 'screenshot-fixtures-'));
    upstream = await startUpstream();
  });

  afterEach(async () => {
    await stop();
    await stopUpstream(upstream);
    rmSync(fixturesDir, { recursive: true, force: true });
  });

  describe('record mode', () => {
    it('records a graphql response, an auth proxy and a redirected asset without persisting a token', async () => {
      await start({ mode: 'record', fresh: true });

      const credentials = await fetch(`${backendOrigin}/auth/native/credentials`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: ACCOUNT_EMAIL, password: 'hunter2' }),
      });
      expect(credentials.status).toBe(200);
      expect(await credentials.json()).toMatchObject({ jwt: UPSTREAM_JWT });

      const graphql = await postGraphql({
        operationName: 'SyncTicks',
        query: SYNC_TICKS_QUERY,
        variables: { cursor: null },
      });
      expect(graphql.status).toBe(200);
      expect(await graphql.json()).toEqual(SYNC_TICKS_RESPONSE);
      // The app's own headers reach the upstream, so a recording runs as the
      // signed-in account rather than anonymously.
      expect(upstream.graphqlRequests[0].authorization).toBe(`Bearer ${UPSTREAM_JWT}`);

      const avatar = await fetch(`${backendOrigin}/static/avatars/marco.jpg?v=3&size=128`);
      expect(avatar.status).toBe(200);
      expect(Buffer.from(await avatar.arrayBuffer())).toEqual(AVATAR_BYTES);
      expect(upstream.staticRequestPaths).toContain('/cdn/redirected-avatar.jpg');

      await stop();

      const manifest = readScreenshotFixtureManifest(fixturesDir);
      expect(manifest).not.toBeNull();
      expect(validateScreenshotFixtureManifest(manifest).ok).toBe(true);
      expect(manifest?.accountEmail).toBe(ACCOUNT_EMAIL);
      // The id out of the live jwt, never the jwt itself.
      expect(manifest?.accountUserId).toBe(ACCOUNT_USER_ID);
      // frozenNow is a FLOOR: rewriteManifest bumps it past any response
      // recorded after it. This fixture's own recordedAt is the real wall
      // clock (new Date().toISOString()), always later than the fixed
      // FROZEN_NOW test constant above — so assert the invariant the feature
      // actually guarantees, not an exact value that would race the clock.
      const recordedFixture = JSON.parse(readFileSync(join(fixturesDir, manifest?.graphql[0].file ?? ''), 'utf8')) as {
        recordedAt: string;
      };
      expect(Date.parse(manifest?.frozenNow ?? '')).toBeGreaterThanOrEqual(Date.parse(FROZEN_NOW));
      expect(Date.parse(manifest?.frozenNow ?? '')).toBeGreaterThan(Date.parse(recordedFixture.recordedAt));
      expect(manifest?.graphql).toHaveLength(1);
      expect(manifest?.graphql[0].operationName).toBe('SyncTicks');
      // Keyed by the ORIGINAL path + sorted query, not the CDN URL it followed.
      expect(manifest?.static[0].path).toBe('/static/avatars/marco.jpg');
      expect(manifest?.static[0].query).toBe('size=128&v=3');
      expect(manifest?.static[0].contentType).toContain('image/jpeg');

      const files = listFixtureFiles(fixturesDir);
      expect(files).toContain('manifest.json');
      expect(files.some((file) => file.startsWith('graphql/SyncTicks/'))).toBe(true);
      expect(files.some((file) => file.startsWith('static/') && file.endsWith('.jpg'))).toBe(true);
      // 16 hex chars of the variables hash — matching the static key length,
      // not the shorter 12-char hash the log lines display.
      const graphqlFixtureBasename = (manifest?.graphql[0].file ?? '').split('/').pop();
      expect(graphqlFixtureBasename).toMatch(/^[0-9a-f]{16}\.json$/);

      // The disk grep: nothing under the fixtures dir may carry a live token or
      // a forwarded credential header.
      for (const file of files) {
        const contents = readFileSync(join(fixturesDir, file), 'utf8');
        expect(contents, `${file} leaked the jwt`).not.toContain(UPSTREAM_JWT);
        // Not just the whole token: its payload segment alone would be a
        // decodable copy of the live session.
        expect(contents, `${file} leaked the jwt payload`).not.toContain(UPSTREAM_JWT_PAYLOAD);
        expect(contents, `${file} leaked the refresh token`).not.toContain(UPSTREAM_REFRESH_TOKEN);
        expect(contents.toLowerCase(), `${file} persisted an authorization header`).not.toContain('authorization');
        expect(contents.toLowerCase(), `${file} persisted a cookie header`).not.toContain('cookie');
      }

      expect(hasLine('RECORDED graphql SyncTicks')).toBe(true);
      expect(hasLine('RECORDED static /static/avatars/marco.jpg?size=128&v=3')).toBe(true);
    });

    it('keeps the first recording and logs a DUP for a repeat', async () => {
      await start({ mode: 'record', fresh: true });
      const request = { operationName: 'SyncTicks', query: SYNC_TICKS_QUERY, variables: { cursor: null } };
      await postGraphql(request);
      upstream.nextGraphqlResponse = { status: 200, body: { data: { syncTicks: { documents: [{ uuid: 'later' }] } } } };
      await postGraphql(request);
      await stop();

      expect(hasLine('DUP graphql SyncTicks')).toBe(true);
      const manifest = readScreenshotFixtureManifest(fixturesDir);
      expect(manifest?.graphql).toHaveLength(1);
      const fixture = JSON.parse(readFileSync(join(fixturesDir, manifest?.graphql[0].file ?? ''), 'utf8')) as {
        response: unknown;
      };
      expect(fixture.response).toEqual(SYNC_TICKS_RESPONSE);
    });

    it('records nothing when the upstream answers a 500', async () => {
      await start({ mode: 'record', fresh: true });
      upstream.nextGraphqlResponse = { status: 500, body: { errors: [{ message: 'boom' }] } };
      const response = await postGraphql({
        operationName: 'Feed',
        query: 'query Feed { feed { uuid } }',
        variables: {},
      });
      expect(response.status).toBe(500);
      await stop();

      expect(hasLine('UPSTREAM-ERROR graphql Feed status=500')).toBe(true);
      expect(readScreenshotFixtureManifest(fixturesDir)?.graphql).toHaveLength(0);
    });

    it('records nothing when the upstream answers 200 with INTERNAL_SERVER_ERROR', async () => {
      await start({ mode: 'record', fresh: true });
      upstream.nextGraphqlResponse = {
        status: 200,
        body: { data: null, errors: [{ message: 'boom', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] },
      };
      await postGraphql({ operationName: 'Feed', query: 'query Feed { feed { uuid } }', variables: {} });
      await stop();

      expect(hasLine('UPSTREAM-ERROR graphql Feed code=INTERNAL_SERVER_ERROR')).toBe(true);
      expect(readScreenshotFixtureManifest(fixturesDir)?.graphql).toHaveLength(0);
    });

    it('refuses to write a fixture whose body carries the live jwt', async () => {
      await start({ mode: 'record', fresh: true });
      await fetch(`${backendOrigin}/auth/native/credentials`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: ACCOUNT_EMAIL, password: 'hunter2' }),
      });
      upstream.nextGraphqlResponse = { status: 200, body: { data: { me: { sessionToken: UPSTREAM_JWT } } } };
      await postGraphql({ operationName: 'Me', query: 'query Me { me { sessionToken } }', variables: {} });
      const stats = backend?.stats();
      await stop();

      expect(hasLine('REDACTED graphql Me')).toBe(true);
      expect(stats?.redacted).toBe(1);
      expect(readScreenshotFixtureManifest(fixturesDir)?.graphql).toHaveLength(0);
      for (const file of listFixtureFiles(fixturesDir)) {
        expect(readFileSync(join(fixturesDir, file), 'utf8')).not.toContain(UPSTREAM_JWT);
      }
    });

    it('refuses to write a fixture whose variables carry a sensitive key, at any depth', async () => {
      await start({ mode: 'record', fresh: true });
      await postGraphql({
        operationName: 'LinkBoardAccount',
        query: 'mutation LinkBoardAccount($input: LinkBoardAccountInput!) { linkBoardAccount(input: $input) { ok } }',
        variables: { input: { username: 'marco', password: 'hunter2' } },
      });
      const stats = backend?.stats();
      await stop();

      expect(hasLine('REDACTED graphql LinkBoardAccount')).toBe(true);
      expect(stats?.redacted).toBe(1);
      expect(readScreenshotFixtureManifest(fixturesDir)?.graphql).toHaveLength(0);
      expect(listFixtureFiles(fixturesDir).some((file) => file.startsWith('graphql/'))).toBe(false);
    });

    it('redacts a per-run push token instead of refusing the fixture, and still replays it', async () => {
      const registerQuery =
        'mutation RegisterToken($sessionId: ID!, $token: String!) { registerActivityPushToken(sessionId: $sessionId, token: $token) { ok } }';
      const registerResponse = { data: { registerActivityPushToken: { ok: true } } };

      await start({ mode: 'record', fresh: true });
      upstream.nextGraphqlResponse = { status: 200, body: registerResponse };
      await postGraphql({
        operationName: 'RegisterToken',
        query: registerQuery,
        variables: { sessionId: 'session-1', token: 'apns-abc' },
      });
      const stats = backend?.stats();
      await stop();

      // The APNs token is a client-generated per-run value, not a login secret:
      // refusing the fixture over it would mean this mutation could never be
      // recorded at all.
      expect(hasLine('REDACTED graphql RegisterToken')).toBe(false);
      expect(stats?.redacted).toBe(0);

      const manifest = readScreenshotFixtureManifest(fixturesDir);
      expect(manifest?.graphql).toHaveLength(1);
      const fixture = JSON.parse(readFileSync(join(fixturesDir, manifest?.graphql[0].file ?? ''), 'utf8')) as {
        variables: { sessionId: string; token: string };
      };
      expect(fixture.variables.token).toBe('<redacted:per-run>');
      expect(fixture.variables.sessionId).toBe('session-1');
      for (const file of listFixtureFiles(fixturesDir)) {
        expect(readFileSync(join(fixturesDir, file), 'utf8'), `${file} leaked the push token`).not.toContain(
          'apns-abc',
        );
      }

      // The next run mints a different token; the key ignores it, so the
      // recorded answer still comes back.
      await start({ mode: 'replay' });
      const replayed = await postGraphql({
        operationName: 'RegisterToken',
        query: registerQuery,
        variables: { sessionId: 'session-1', token: 'apns-a-different-run' },
      });
      expect(replayed.status).toBe(200);
      expect(await replayed.json()).toEqual(registerResponse);
      expect(hasLine('HIT graphql RegisterToken')).toBe(true);
    });

    it('treats a malicious operationName as anonymous rather than writing outside the fixtures dir', async () => {
      await start({ mode: 'record', fresh: true });
      // An anonymous query text, so a rejected operationName has nothing to
      // fall back to and the request is reported as nameless — not written
      // under a directory named `../../escape`.
      const response = await postGraphql({
        operationName: '../../escape',
        query: '{ climbs { uuid } }',
        variables: {},
      });
      expect(response.status).toBe(200);
      await stop();

      expect(hasLine('UPSTREAM-ERROR graphql anonymous status=200')).toBe(true);
      expect(readScreenshotFixtureManifest(fixturesDir)?.graphql).toHaveLength(0);
      expect(listFixtureFiles(fixturesDir)).toEqual(['manifest.json']);
      // Nothing escaped the temp fixtures dir: no sibling `escape` directory.
      expect(existsSync(resolve(fixturesDir, '..', 'escape'))).toBe(false);
    });

    it('notes a fixture size using the bytes actually written to disk, not the compact string length', async () => {
      await start({ mode: 'record', fresh: true });
      const bigValue = 'x'.repeat(FIXTURE_SIZE_NOTE_BYTES + 1024);
      await postGraphql({
        operationName: 'BigPayload',
        query: 'query BigPayload { ok }',
        variables: { note: bigValue },
      });
      await stop();

      const manifest = readScreenshotFixtureManifest(fixturesDir);
      const fixtureFile = manifest?.graphql.find((entry) => entry.operationName === 'BigPayload')?.file ?? '';
      const diskFixture: unknown = JSON.parse(readFileSync(join(fixturesDir, fixtureFile), 'utf8'));
      const writtenBytes = Buffer.byteLength(JSON.stringify(diskFixture, null, 2));
      const compactLength = JSON.stringify(diskFixture).length;
      // The pretty-printed bytes actually on disk, not the compact length —
      // the two differ once indentation is counted.
      expect(writtenBytes).not.toBe(compactLength);
      expect(hasLine(fixtureSizeNote(writtenBytes))).toBe(true);
    });
  });

  describe('replay mode', () => {
    beforeEach(async () => {
      await start({ mode: 'record', fresh: true });
      await fetch(`${backendOrigin}/auth/native/credentials`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: ACCOUNT_EMAIL, password: 'hunter2' }),
      });
      await postGraphql({ operationName: 'SyncTicks', query: SYNC_TICKS_QUERY, variables: { cursor: null } });
      await fetch(`${backendOrigin}/static/avatars/marco.jpg?v=3&size=128`);
      await stop();
      await start({ mode: 'replay' });
    });

    it('answers a recorded operation from disk and makes no outbound request', async () => {
      const requestsBefore = upstream.graphqlRequests.length;
      const response = await postGraphql({
        operationName: 'SyncTicks',
        query: SYNC_TICKS_QUERY,
        variables: { cursor: null },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(SYNC_TICKS_RESPONSE);
      expect(upstream.graphqlRequests).toHaveLength(requestsBefore);
      expect(hasLine('HIT graphql SyncTicks')).toBe(true);
      expect(backend?.stats().hits).toBeGreaterThan(0);
    });

    it('caches a hot fixture body on first replay hit and does not re-read the file afterward', async () => {
      const first = await postGraphql({
        operationName: 'SyncTicks',
        query: SYNC_TICKS_QUERY,
        variables: { cursor: null },
      });
      expect(await first.json()).toEqual(SYNC_TICKS_RESPONSE);

      const entry = readScreenshotFixtureManifest(fixturesDir)?.graphql.find(
        (graphqlEntry) => graphqlEntry.operationName === 'SyncTicks',
      );
      const fixturePath = join(fixturesDir, entry?.file ?? '');
      const onDiskFixture: Record<string, unknown> = JSON.parse(readFileSync(fixturePath, 'utf8'));
      const mutatedResponse = { data: { syncTicks: { documents: [{ uuid: 'mutated-after-cache' }] } } };
      // Mutate the file on disk directly, bypassing the server. If the second
      // request re-read it, it would see this; the cache means it can't.
      writeFileSync(fixturePath, JSON.stringify({ ...onDiskFixture, response: mutatedResponse }), 'utf8');

      const second = await postGraphql({
        operationName: 'SyncTicks',
        query: SYNC_TICKS_QUERY,
        variables: { cursor: null },
      });
      expect(await second.json()).toEqual(SYNC_TICKS_RESPONSE);
    });

    it('hits the same fixture when only the document whitespace changed', async () => {
      const response = await postGraphql({
        operationName: 'SyncTicks',
        query: SYNC_TICKS_QUERY.replace(/\s+/g, ' '),
        variables: { cursor: null },
      });
      expect(await response.json()).toEqual(SYNC_TICKS_RESPONSE);
      expect(hasLine('HIT graphql SyncTicks')).toBe(true);
    });

    it('reports document-changed, not no-fixture, when the selection set moved', async () => {
      const response = await postGraphql({
        operationName: 'SyncTicks',
        query: SYNC_TICKS_QUERY.replace('documents', 'documents hasMore'),
        variables: { cursor: null },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        errors: [{ extensions: { code: 'SCREENSHOT_FIXTURE_MISS' } }],
      });
      expect(hasLine('reason=document-changed')).toBe(true);
    });

    it('answers a miss with 200 and a GraphQL error, never a 5xx', async () => {
      const response = await postGraphql({
        operationName: 'NeverRecorded',
        query: 'query NeverRecorded { ok }',
        variables: {},
      });
      // A 5xx here would flip the app's connectivity store into "backend
      // unreachable" and put an offline banner over the screen being captured.
      expect(response.status).toBe(200);
      const body = (await response.json()) as { errors: Array<{ message: string; extensions: { code: string } }> };
      expect(body.errors[0].extensions.code).toBe('SCREENSHOT_FIXTURE_MISS');
      expect(body.errors[0].message).toContain('NeverRecorded');
      expect(hasLine('reason=no-fixture')).toBe(true);
    });

    it('names an anonymous operation as its own miss reason', async () => {
      const response = await postGraphql({ query: '{ climbs { uuid } }', variables: {} });
      expect(response.status).toBe(200);
      expect(hasLine('reason=anonymous-operation')).toBe(true);
    });

    it('refuses a batched request rather than guessing', async () => {
      const response = await fetch(`${backendOrigin}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([{ operationName: 'SyncTicks', query: SYNC_TICKS_QUERY }]),
      });
      expect(response.status).toBe(400);
      expect(hasLine('MISS route POST /graphql (batched)')).toBe(true);
    });

    it('signs in the recorded account with synthetic tokens and rejects any other', async () => {
      const accepted = await fetch(`${backendOrigin}/auth/native/credentials`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: ACCOUNT_EMAIL, password: 'anything' }),
      });
      expect(accepted.status).toBe(200);
      const session = (await accepted.json()) as { jwt: string; refreshToken: string; expiresAt: string };
      // A decodable jwt SHAPE: the app reads its own user id back out of this
      // token, and anything but three segments reads to it as "no id".
      expect(session.jwt.split('.')).toHaveLength(3);
      expect(subjectFromJwt(session.jwt)).toBe(ACCOUNT_USER_ID);
      expect(session.refreshToken).toBe('screenshot-replay-refresh');
      expect(Date.parse(session.expiresAt)).toBeGreaterThan(Date.now());
      expect(session.jwt).not.toContain(UPSTREAM_JWT);
      // Well clear of the app's own 24h isTokenExpiringSoon threshold
      // (packages/mobile/src/lib/auth-store.ts) — a 24h expiry here would read
      // as "expiring soon" on the very first check and loop the capture into
      // a refresh on every request.
      expect(Date.parse(session.expiresAt)).toBeGreaterThan(Date.now() + 48 * 60 * 60 * 1000);
      expect(hasLine('HIT auth credentials')).toBe(true);

      const refreshed = await fetch(`${backendOrigin}/auth/native/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: 'screenshot-replay-refresh' }),
      });
      expect(refreshed.status).toBe(200);
      const refreshedSession = (await refreshed.json()) as { jwt: string; refreshToken: string };
      expect(refreshedSession.refreshToken).toBe('screenshot-replay-refresh');
      expect(subjectFromJwt(refreshedSession.jwt)).toBe(ACCOUNT_USER_ID);
      expect(hasLine('HIT auth refresh')).toBe(true);

      const rejected = await fetch(`${backendOrigin}/auth/native/credentials`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'someone@else.com', password: 'anything' }),
      });
      expect(rejected.status).toBe(401);
      expect(hasLine('MISS auth email=someone@else.com expected=shots@boardsesh.com')).toBe(true);
    });

    it('serves a recorded asset with its recorded content type, in any parameter order', async () => {
      const response = await fetch(`${backendOrigin}/static/avatars/marco.jpg?size=128&v=3`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('image/jpeg');
      expect(Buffer.from(await response.arrayBuffer())).toEqual(AVATAR_BYTES);
      expect(hasLine('HIT static /static/avatars/marco.jpg?size=128&v=3')).toBe(true);
    });

    it('404s an asset nobody recorded', async () => {
      const response = await fetch(`${backendOrigin}/static/avatars/nobody.jpg`);
      expect(response.status).toBe(404);
      expect(hasLine('MISS static /static/avatars/nobody.jpg')).toBe(true);
    });

    it('answers a miss, not a 500, when a fixture disappears after startup', async () => {
      const manifest = readScreenshotFixtureManifest(fixturesDir);
      rmSync(join(fixturesDir, manifest?.graphql[0].file ?? ''));

      const response = await postGraphql({
        operationName: 'SyncTicks',
        query: SYNC_TICKS_QUERY,
        variables: { cursor: null },
      });
      // A 5xx would flip the app into "backend unreachable" and hide the very
      // thing the log is reporting.
      expect(response.status).toBe(200);
      const body = (await response.json()) as { errors: Array<{ extensions: { code: string } }> };
      expect(body.errors[0].extensions.code).toBe('SCREENSHOT_FIXTURE_MISS');
      expect(hasLine('reason=unreadable-fixture')).toBe(true);

      rmSync(join(fixturesDir, manifest?.static[0].file ?? ''));
      const asset = await fetch(`${backendOrigin}/static/avatars/marco.jpg?size=128&v=3`);
      expect(asset.status).toBe(404);
      expect(hasLine('MISS static /static/avatars/marco.jpg?size=128&v=3')).toBe(true);
    });

    it('answers the health probe in the shape backend-reachability classifies as healthy', async () => {
      for (const path of ['/health', '/health/db']) {
        const response = await fetch(`${backendOrigin}${path}`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          status: 'healthy',
          database: { reachable: true },
          screenshotBackend: true,
        });
      }
    });

    it('404s an unknown route instead of quietly proxying it', async () => {
      const response = await fetch(`${backendOrigin}/api/v1/climbs`);
      expect(response.status).toBe(404);
      expect(hasLine('MISS route GET /api/v1/climbs')).toBe(true);
    });

    it('reports its counters over the status route', async () => {
      await postGraphql({ operationName: 'SyncTicks', query: SYNC_TICKS_QUERY, variables: { cursor: null } });
      await postGraphql({ operationName: 'NeverRecorded', query: 'query NeverRecorded { ok }', variables: {} });
      const response = await fetch(`${backendOrigin}/__screenshot-backend/status`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        mode: 'replay',
        hits: 1,
        misses: 1,
        recorded: 0,
        fixtures: { graphql: 1, static: 1 },
      });
    });

    it('acks a graphql-ws handshake, pongs a ping, and stays silent on a subscribe', async () => {
      const socket = new WebSocket(`${backendOrigin.replace('http://', 'ws://')}/graphql`, 'graphql-transport-ws');
      const received: Array<Record<string, unknown>> = [];
      await new Promise<void>((resolve, reject) => {
        socket.on('open', () => resolve());
        socket.on('error', reject);
      });
      socket.on('message', (frame) =>
        received.push(JSON.parse(Buffer.from(frame as Buffer).toString('utf8')) as Record<string, unknown>),
      );

      socket.send(JSON.stringify({ type: 'connection_init' }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(received).toEqual([{ type: 'connection_ack' }]);

      socket.send(JSON.stringify({ type: 'ping' }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(received[1]).toEqual({ type: 'pong' });

      socket.send(
        JSON.stringify({
          id: '1',
          type: 'subscribe',
          payload: { operationName: 'ClimbStatsUpdated', query: 'subscription ClimbStatsUpdated { ok }' },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      // Silence is the contract: the store screens render fine when the
      // subscription never emits, so an inert socket is the right fixture.
      expect(received).toHaveLength(2);
      expect(socket.readyState).toBe(WebSocket.OPEN);
      expect(hasLine('WS connection_init ack')).toBe(true);
      expect(hasLine('WS subscribe ClimbStatsUpdated')).toBe(true);
      socket.close();
    });

    it('does not crash on a malformed frame and keeps serving HTTP afterward', async () => {
      const socket = new WebSocket(`${backendOrigin.replace('http://', 'ws://')}/graphql`, 'graphql-transport-ws');
      await new Promise<void>((resolve, reject) => {
        socket.on('open', () => resolve());
        socket.on('error', reject);
      });
      socket.on('error', () => {
        // Expected: the malformed frame below is itself the protocol error
        // under test, not a test failure.
      });
      socket.send(JSON.stringify({ type: 'connection_init' }));
      await new Promise((resolve) => setTimeout(resolve, 100));

      // FIN=1, RSV1=1 (reserved bit set, no extension negotiated), opcode=text,
      // unmasked len=2, payload "{}" — `ws` rejects this as a protocol error.
      const rawSocket = (socket as unknown as { _socket: Socket })._socket;
      rawSocket.write(Buffer.from([0xc1, 0x02, 0x7b, 0x7d]));
      await new Promise((resolve) => setTimeout(resolve, 100));

      const health = await fetch(`${backendOrigin}/health`);
      expect(health.status).toBe(200);
      socket.close();
    });

    it('destroys a websocket upgrade on any other path', async () => {
      const socket = new WebSocket(`${backendOrigin.replace('http://', 'ws://')}/realtime`, 'graphql-transport-ws');
      await expect(
        new Promise<void>((resolve, reject) => {
          socket.on('open', () => reject(new Error('the upgrade should not have been accepted')));
          socket.on('error', () => resolve());
          socket.on('close', () => resolve());
        }),
      ).resolves.toBeUndefined();
    });
  });

  // A viewport batch's id list is assembled from whatever rows had mounted when
  // the batch flushed, so replay (which is instant) asks for subsets the
  // recording never sent. These are the composed answers that fix it — see
  // BATCHED_OPERATIONS in scripts/lib/screenshot-fixtures.ts.
  describe('batched replay', () => {
    const CLIMB_STATS_QUERY =
      'query ClimbStatsForClimbs($boardName: String!, $climbUuids: [ID!]!) {\n' +
      '  climbStatsForClimbs(boardName: $boardName, climbUuids: $climbUuids) {\n' +
      '    climbUuid\n    angle\n  }\n}';

    type StatsRow = { climbUuid: string; angle: number };
    const statsRow = (climbUuid: string, angle: number): StatsRow => ({ climbUuid, angle });

    const recordBatch = async (boardName: string, climbUuids: string[], rows: StatsRow[]): Promise<void> => {
      upstream.nextGraphqlResponse = { status: 200, body: { data: { climbStatsForClimbs: rows } } };
      await postGraphql({
        operationName: 'ClimbStatsForClimbs',
        query: CLIMB_STATS_QUERY,
        variables: { boardName, climbUuids },
      });
    };

    const replayBatch = (boardName: string, climbUuids: string[]): Promise<Response> =>
      postGraphql({
        operationName: 'ClimbStatsForClimbs',
        query: CLIMB_STATS_QUERY,
        variables: { boardName, climbUuids },
      });

    const rowsOf = async (response: Response): Promise<StatsRow[]> =>
      ((await response.json()) as { data: { climbStatsForClimbs: StatsRow[] } }).data.climbStatsForClimbs;

    beforeEach(async () => {
      await start({ mode: 'record', fresh: true });
      // One climb yields a row PER ANGLE, so an id maps to many items.
      await recordBatch(
        'kilter',
        ['climb-a', 'climb-b'],
        [statsRow('climb-a', 0), statsRow('climb-a', 20), statsRow('climb-b', 40)],
      );
      // Recorded, and the backend genuinely had nothing for it. That is a fact,
      // not a gap: it must compose to an empty list, never a miss.
      await recordBatch('kilter', ['climb-c'], []);
      // Same climb, other board. Its rows must never answer a kilter request.
      await recordBatch('tension', ['climb-a'], [statsRow('climb-a', 10)]);
      await stop();
      await start({ mode: 'replay' });
    });

    it('composes an unrecorded id subset, in request order, and logs it as a hit', async () => {
      const response = await replayBatch('kilter', ['climb-b', 'climb-a']);
      expect(response.status).toBe(200);
      // Request order, and every angle row for each id.
      expect(await rowsOf(response)).toEqual([
        statsRow('climb-b', 40),
        statsRow('climb-a', 0),
        statsRow('climb-a', 20),
      ]);
      expect(hasLine('HIT graphql ClimbStatsForClimbs')).toBe(true);
      expect(hasLine('composed=2')).toBe(true);
      expect(backend?.stats().hits).toBeGreaterThan(0);
    });

    it('treats an id recorded with no rows as recorded, contributing nothing rather than missing', async () => {
      // climb-c was asked for and the backend had nothing for it. Composed
      // alongside an id that does have rows, it must simply contribute none —
      // if it counted as unrecorded, that climb would miss forever however
      // often the set is re-recorded.
      const response = await replayBatch('kilter', ['climb-a', 'climb-c']);
      expect(await rowsOf(response)).toEqual([statsRow('climb-a', 0), statsRow('climb-a', 20)]);
      expect(hasLine('composed=2')).toBe(true);
    });

    it('never composes across the non-id variables: a kilter recording cannot answer a tension request', async () => {
      // climb-b exists in the recorded set, but only under boardName kilter.
      const response = await replayBatch('tension', ['climb-a', 'climb-b']);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ errors: [{ extensions: { code: 'SCREENSHOT_FIXTURE_MISS' } }] });
      expect(hasLine('reason=unrecorded-ids ids=climb-b')).toBe(true);

      // And the id that IS recorded under tension answers with tension's row.
      expect(await rowsOf(await replayBatch('tension', ['climb-a']))).toEqual([statsRow('climb-a', 10)]);
    });

    it('names the ids nothing recorded, so the failure says which screen to re-record', async () => {
      const response = await replayBatch('kilter', ['climb-a', 'climb-z']);
      expect(response.status).toBe(200);
      expect(hasLine('reason=unrecorded-ids ids=climb-z')).toBe(true);
      const [problem] = findScreenshotBackendProblems(logLines.join('\n'), { mode: 'replay' });
      expect(problem).toContain('ClimbStatsForClimbs asked for ids no recorded batch covers: climb-z');
      expect(problem).toContain('"boardName":"kilter"');
      expect(problem).toContain(RE_RECORD_COMMAND);
    });

    it('counts a composed hit as a graphql hit for the problem scanner', async () => {
      await replayBatch('kilter', ['climb-a']);
      // A composed answer is the only graphql traffic here, so the "app never
      // reached the replay backend" check must be satisfied by it alone.
      expect(findScreenshotBackendProblems(logLines.join('\n'), { mode: 'replay' })).toEqual([]);
    });
  });

  describe('startup guards', () => {
    /** One recorded fixture set (auth + one query + one asset) to then corrupt. */
    const recordOnce = async (): Promise<void> => {
      await start({ mode: 'record', fresh: true });
      await fetch(`${backendOrigin}/auth/native/credentials`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: ACCOUNT_EMAIL, password: 'hunter2' }),
      });
      await postGraphql({ operationName: 'SyncTicks', query: SYNC_TICKS_QUERY, variables: { cursor: null } });
      await fetch(`${backendOrigin}/static/avatars/marco.jpg?v=3&size=128`);
      await stop();
    };

    /** The error `listen` rejected with, or null when it resolved instead. */
    const listenFailure = async (): Promise<Error | null> => {
      backend = createScreenshotBackend({
        mode: 'replay',
        fixturesDir,
        upstreamUrl: null,
        frozenNow: FROZEN_NOW,
        log: (line) => logLines.push(line),
      });
      return backend.listen(0).then(
        () => null,
        (listenError: unknown) => listenError as Error,
      );
    };

    it('refuses to start when a recorded graphql fixture is truncated, and names the file', async () => {
      await recordOnce();
      const fixtureFile = readScreenshotFixtureManifest(fixturesDir)?.graphql[0].file ?? '';
      const fixturePath = join(fixturesDir, fixtureFile);
      writeFileSync(fixturePath, readFileSync(fixturePath, 'utf8').slice(0, 40), 'utf8');

      const failure = await listenFailure();
      // Catching this at request time instead would cost the whole capture:
      // the run is long, unattended, and the PNGs come out looking plausible.
      expect(failure, 'listen resolved on a truncated fixture').not.toBeNull();
      expect(failure?.message).toContain(fixtureFile);
      expect(failure?.message).toContain('record one again');
    });

    it('refuses to start when a recorded asset no longer matches its byte count', async () => {
      await recordOnce();
      const staticFile = readScreenshotFixtureManifest(fixturesDir)?.static[0].file ?? '';
      writeFileSync(join(fixturesDir, staticFile), Buffer.concat([AVATAR_BYTES, Buffer.from('truncated-or-grown')]));

      const failure = await listenFailure();
      expect(failure, 'listen resolved on an asset with the wrong byte count').not.toBeNull();
      expect(failure?.message).toContain(staticFile);
      expect(failure?.message).toContain('bytes');
    });

    it('refuses to replay a fixture set that does not exist', async () => {
      expect(() =>
        createScreenshotBackend({
          mode: 'replay',
          fixturesDir,
          upstreamUrl: null,
          frozenNow: FROZEN_NOW,
          log: () => {},
        }),
      ).toThrow(/no manifest.json/);
    });

    it('refuses a corrupt manifest and names the field', async () => {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(
        join(fixturesDir, 'manifest.json'),
        JSON.stringify({
          formatVersion: 1,
          recordedAt: '',
          frozenNow: 'x',
          upstream: 'x',
          accountEmail: '',
          flow: '',
          graphql: [],
          static: [],
        }),
      );
      expect(() =>
        createScreenshotBackend({
          mode: 'replay',
          fixturesDir,
          upstreamUrl: null,
          frozenNow: FROZEN_NOW,
          log: () => {},
        }),
      ).toThrow(/recordedAt/);
    });

    it('refuses an upstream in replay mode', () => {
      expect(() =>
        createScreenshotBackend({
          mode: 'replay',
          fixturesDir,
          upstreamUrl: 'https://ws.boardsesh.com',
          frozenNow: FROZEN_NOW,
          log: () => {},
        }),
      ).toThrow(/replay mode makes no outbound requests/);
    });
  });
});

describe('isFixtureFileWithinDirectory', () => {
  it('accepts a fixture file that resolves under the fixtures directory', () => {
    expect(isFixtureFileWithinDirectory('/tmp/screenshot-fixtures', 'graphql/SyncTicks/abcdef0123456789.json')).toBe(
      true,
    );
    expect(isFixtureFileWithinDirectory('/tmp/screenshot-fixtures', 'static/deadbeefdeadbeef.jpg')).toBe(true);
  });

  it('rejects a doctored entry.file that would resolve outside the fixtures directory', () => {
    // `validateScreenshotFixtureManifest` already refuses to load a manifest
    // whose `file` looks like this — this is the belt to that validator's
    // braces, exercised directly since a manifest shaped like this can never
    // reach a running replay server to trigger it end to end.
    expect(isFixtureFileWithinDirectory('/tmp/screenshot-fixtures', '../../etc/passwd')).toBe(false);
    expect(isFixtureFileWithinDirectory('/tmp/screenshot-fixtures', '/etc/passwd')).toBe(false);
    expect(isFixtureFileWithinDirectory('/tmp/screenshot-fixtures', 'graphql/../../escape.json')).toBe(false);
  });
});
