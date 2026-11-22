/// <reference types="node" />

import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET_USER_ASCENTS_FEED } from '../../packages/shared/graphql/src/operations/ticks';
import { main, recordMobileSmokeProjects } from '../record-mobile-smoke-projects';
import { createScreenshotBackend } from '../lib/screenshot-backend';
import { createFixtureSnapshotArchive } from '../lib/screenshot-fixture-archive';
import { applyFixtureOverlay } from '../lib/screenshot-fixture-overlay';
import {
  decodeFixtureSnapshot,
  FIXTURE_SNAPSHOT_REFERENCE,
  snapshotHash,
  type FixtureSnapshotReference,
} from '../lib/screenshot-fixture-snapshot';
import { emptyManifest, graphqlFixtureKey, type GraphqlFixtureFile } from '../lib/screenshot-fixtures';

const UPSTREAM = 'https://ws.boardsesh.com';
const EMAIL = 'shots@boardsesh.com';
const ACCOUNT_ID = '11111111-2222-4333-8444-555555555555';
const PASSWORD = 'secret-password-never-exported';
const JWT = `header.${Buffer.from(JSON.stringify({ sub: ACCOUNT_ID })).toString('base64url')}.live-signature`;
const REFRESH_TOKEN = 'live-refresh-token-never-exported';
const ATTEMPT = {
  uuid: 'attempt-one',
  climbUuid: 'climb-one',
  climbName: 'Keep trying',
  setterUsername: 'manufacturer_setter',
  boardType: 'kilter',
  boardId: 4,
  boardDisplayName: 'Home wall',
  layoutId: 8,
  renderBoard: { layoutId: 8, sizeId: 25, setIds: '26,27,28,29' },
  angle: 40,
  isMirror: false,
  status: 'attempt',
  attemptCount: 3,
  quality: null,
  effectiveQuality: null,
  difficulty: null,
  difficultyName: null,
  consensusDifficulty: null,
  consensusDifficultyName: null,
  boardseshDifficulty: null,
  boardseshConfidence: null,
  qualityAverage: null,
  isBenchmark: false,
  isNoMatch: false,
  characteristics: null,
  comment: 'Still trying',
  climbedAt: '2026-11-16T08:00:00Z',
  frames: 'p1r12',
  hasBetaVideo: false,
};
const ATTEMPTS = { data: { userAscentsFeed: { items: [ATTEMPT], totalCount: 1, hasMore: false } } };
const VARIABLES = { userId: ACCOUNT_ID, input: { statusMode: 'attempt', limit: 50, offset: 0 } };

let directory: string;
let baseDirectory: string;
let outputDirectory: string;
let reference: FixtureSnapshotReference;
let baseArchive: Buffer;
let upstream: Server;
let authSubject: string;
let responseBody: unknown;
let requests: Array<{ path: string; body: unknown }>;
let closedModes: string[];

const factory: typeof createScreenshotBackend = (options) => {
  const backend = createScreenshotBackend(options);
  return {
    ...backend,
    close: async () => {
      await backend.close();
      closedModes.push(options.mode);
    },
  };
};

function addFixture(operationName: string, query: string, variables: unknown, response: unknown): void {
  const manifest = JSON.parse(readFileSync(join(baseDirectory, 'manifest.json'), 'utf8'));
  const key = graphqlFixtureKey({ operationName, query, variables }, (text) => snapshotHash(Buffer.from(text)));
  const file = `graphql/${operationName}/${key.variablesHash.slice(0, 16)}.json`;
  const fixture: GraphqlFixtureFile = {
    formatVersion: 1,
    ...key,
    query,
    variables,
    response,
    status: 200,
    recordedAt: manifest.recordedAt,
    upstream: 'authorized-screenshot-demo-profile',
  };
  mkdirSync(dirname(join(baseDirectory, file)), { recursive: true });
  writeFileSync(join(baseDirectory, file), JSON.stringify(fixture));
  manifest.graphql.push({ ...key, file });
  writeFileSync(join(baseDirectory, 'manifest.json'), JSON.stringify(manifest));
}

function archiveBase(): void {
  const archived = createFixtureSnapshotArchive(baseDirectory);
  baseArchive = archived.compressed;
  reference = { ...archived.reference, url: 'https://fixtures.example.invalid/base.json.gz' };
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'smoke-projects-test-'));
  baseDirectory = join(directory, 'base');
  outputDirectory = join(directory, 'candidate');
  mkdirSync(baseDirectory);
  writeFileSync(
    join(baseDirectory, 'manifest.json'),
    JSON.stringify(
      emptyManifest({
        recordedAt: '2026-11-16T08:29:06Z',
        frozenNow: '2026-11-16T08:29:08Z',
        upstream: UPSTREAM,
        accountEmail: EMAIL,
        accountUserId: ACCOUNT_ID,
        flow: 'help',
      }),
    ),
  );
  addFixture('GetProfile', 'query GetProfile { profile { id } }', {}, { data: { profile: { id: ACCOUNT_ID } } });
  archiveBase();
  authSubject = ACCOUNT_ID;
  responseBody = ATTEMPTS;
  requests = [];
  closedModes = [];
  upstream = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      requests.push({ path: request.url!, body: JSON.parse(body) });
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify(
          request.url === '/auth/native/credentials'
            ? {
                jwt:
                  authSubject === ACCOUNT_ID
                    ? JWT
                    : `header.${Buffer.from(JSON.stringify({ sub: authSubject })).toString('base64url')}.foreign`,
                refreshToken: REFRESH_TOKEN,
              }
            : responseBody,
        ),
      );
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('No upstream socket');
  const origin = `http://127.0.0.1:${address.port}`;
  const originalFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    return originalFetch(url.startsWith(UPSTREAM) ? url.replace(UPSTREAM, origin) : input, init);
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  upstream.closeAllConnections();
  await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())));
  rmSync(directory, { recursive: true, force: true });
});

const record = (overlayBytes?: Buffer) =>
  recordMobileSmokeProjects(
    { reference, baseArchive, overlayBytes, outputDirectory, email: EMAIL, password: PASSWORD },
    factory,
  );

describe('genuine mobile smoke projects recording', () => {
  it('records only the pinned account attempts page, preserving all existing bytes and committed pins', async () => {
    const oldFiles = decodeFixtureSnapshot(baseArchive, reference);
    const pinBytes = readFileSync(FIXTURE_SNAPSHOT_REFERENCE);
    const result = await record();
    expect(requests).toEqual([
      { path: '/auth/native/credentials', body: { email: EMAIL, password: PASSWORD } },
      {
        path: '/graphql',
        body: { operationName: 'GetUserAscentsFeed', query: GET_USER_ASCENTS_FEED, variables: VARIABLES },
      },
    ]);
    const exported = readFileSync(join(result.exportDirectory, `${result.overlay.sha256}.json.gz`));
    const next = applyFixtureOverlay(oldFiles, reference.sha256, exported, result.overlay);
    for (const [path, bytes] of oldFiles) {
      if (path !== 'manifest.json') expect(next.get(path)).toEqual(bytes);
    }
    expect(next.size).toBe(oldFiles.size + 1);
    expect(result.proof).toMatchObject({ addedGraphqlFiles: 1, replayHits: 1, replayMisses: 0 });
    expect(readFileSync(FIXTURE_SNAPSHOT_REFERENCE)).toEqual(pinBytes);
    const text = gunzipSync(exported).toString();
    const serializedFiles = [...next.values()].map((bytes) => bytes.toString()).join('\n');
    for (const secret of [PASSWORD, JWT, REFRESH_TOKEN]) expect(`${text}${serializedFiles}`).not.toContain(secret);
    expect(closedModes).toEqual(['record', 'replay']);
  });

  it('carries forward existing overlay files without changing their bytes or baseline hash', async () => {
    const baseline = decodeFixtureSnapshot(baseArchive, reference);
    addFixture('OtherRead', 'query OtherRead { ok }', {}, { data: { ok: true } });
    const previous = createFixtureSnapshotArchive(baseDirectory);
    const previousFiles = decodeFixtureSnapshot(previous.compressed, previous.reference);
    const overlayBytes = gzipSync(
      JSON.stringify({
        version: 1,
        baseSha256: reference.sha256,
        files: Object.fromEntries(
          [...previousFiles]
            .filter(([path]) => path === 'manifest.json' || !baseline.has(path))
            .map(([path, bytes]) => [path, bytes.toString('base64')]),
        ),
      }),
    );
    const sha256 = snapshotHash(overlayBytes);
    reference.overlay = {
      path: `app-stores/screenshot-fixture-overlays/${sha256}.json.gz`,
      sha256,
      bytes: overlayBytes.length,
      files: previousFiles.size,
    };
    const result = await record(overlayBytes);
    const next = applyFixtureOverlay(
      baseline,
      reference.sha256,
      readFileSync(join(result.exportDirectory, `${result.overlay.sha256}.json.gz`)),
      result.overlay,
    );
    for (const [path, bytes] of previousFiles) if (path !== 'manifest.json') expect(next.get(path)).toEqual(bytes);
    expect(result.proof.previousOverlaySha256).toBe(sha256);
  });

  it('rejects a wrong authenticated owner before querying', async () => {
    authSubject = 'foreign-account';
    await expect(record()).rejects.toThrow('Authenticate the original screenshot account');
    expect(requests.map(({ path }) => path)).toEqual(['/auth/native/credentials']);
    expect(existsSync(join(outputDirectory, 'export'))).toBe(false);
    expect(closedModes).toEqual(['record']);
  });

  it('rejects a mismatched configured account and checksum before authenticating', async () => {
    await expect(
      recordMobileSmokeProjects({
        reference,
        baseArchive,
        outputDirectory,
        email: 'wrong@example.com',
        password: PASSWORD,
      }),
    ).rejects.toThrow('Verify the pinned');
    baseArchive = Buffer.concat([baseArchive, Buffer.from('corrupt')]);
    await expect(record()).rejects.toThrow('Verify the pinned');
    expect(requests).toEqual([]);
  });

  it('refuses a collision for the exact variables even when its document differs', async () => {
    addFixture('GetUserAscentsFeed', 'query GetUserAscentsFeed { olderSelection }', VARIABLES, { data: {} });
    archiveBase();
    await expect(record()).rejects.toThrow('Verify the pinned');
    expect(requests).toEqual([]);
    expect(existsSync(outputDirectory)).toBe(false);
  });

  it.each(['extra-secret', 'live-token', 'missing-field', 'wrong-status', 'partial-error'])(
    'exports no candidate for unsafe or malformed %s data',
    async (failure) => {
      if (failure === 'extra-secret') responseBody = { ...ATTEMPTS, password: PASSWORD };
      if (failure === 'live-token')
        responseBody = {
          data: { userAscentsFeed: { ...ATTEMPTS.data.userAscentsFeed, items: [{ ...ATTEMPT, comment: JWT }] } },
        };
      if (failure === 'missing-field') responseBody = { data: { userAscentsFeed: { items: [], totalCount: 0 } } };
      if (failure === 'wrong-status')
        responseBody = {
          data: { userAscentsFeed: { ...ATTEMPTS.data.userAscentsFeed, items: [{ ...ATTEMPT, status: 'send' }] } },
        };
      if (failure === 'partial-error') responseBody = { ...ATTEMPTS, errors: [{ message: REFRESH_TOKEN }] };
      let caught: unknown;
      try {
        await record();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      for (const secret of [PASSWORD, JWT, REFRESH_TOKEN]) expect(String(caught)).not.toContain(secret);
      expect(existsSync(join(outputDirectory, 'export'))).toBe(false);
      expect(closedModes).toEqual(['record']);
    },
  );
});

describe('protected fixed smoke query workflow', () => {
  it('uses a protected exact-main checkout before exposing credentials, with no dispatch inputs or publication', () => {
    const source = readFileSync('.github/workflows/mobile-smoke-projects-fixtures.yml', 'utf8');
    const workflow = parse(source) as {
      on: Record<string, unknown>;
      permissions: Record<string, string>;
      jobs: Record<string, { if: string; environment: string; steps: Array<Record<string, unknown>> }>;
    };
    expect(workflow.on).toEqual({ workflow_dispatch: null });
    expect(workflow.permissions).toEqual({ contents: 'read' });
    const job = workflow.jobs['record-projects'];
    expect(job.if).toBe("${{ github.ref == 'refs/heads/main' && github.ref_protected }}");
    expect(job.environment).toBe('Production');
    expect(job.steps[0].with).toEqual({ ref: '${{ github.sha }}', 'persist-credentials': false });
    expect(String(job.steps[1].run)).toContain('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"');
    const credentialIndex = job.steps.findIndex((step) => objectEnv(step.env)?.SCREENSHOT_USER_PASSWORD);
    expect(credentialIndex).toBeGreaterThan(1);
    expect(job.steps.at(-1)?.with).toMatchObject({
      name: 'mobile-smoke-projects-candidate',
      path: '${{ runner.temp }}/mobile-smoke-projects-candidate/export/',
      'if-no-files-found': 'error',
    });
    expect(source).not.toMatch(/inputs\.|contents: write|git push|fastlane|maestro|gh release/);
  });

  it('rejects a non-main CLI invocation before reading the snapshot or authenticating', async () => {
    vi.stubEnv('RUNNER_TEMP', directory);
    vi.stubEnv('GITHUB_EVENT_NAME', 'workflow_dispatch');
    vi.stubEnv('GITHUB_REF', 'refs/heads/feature');
    const args = process.argv;
    process.argv = ['node', 'record-mobile-smoke-projects.ts'];
    try {
      await expect(main()).rejects.toThrow('protected main dispatch checkout');
    } finally {
      process.argv = args;
    }
    expect(requests).toEqual([]);
  });
});

function objectEnv(candidate: unknown): Record<string, unknown> | null {
  return candidate !== null && typeof candidate === 'object' ? (candidate as Record<string, unknown>) : null;
}
