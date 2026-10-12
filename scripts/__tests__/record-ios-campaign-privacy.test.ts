/// <reference types="node" />

import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET_PRIVACY_SETTINGS } from '../../packages/shared/graphql/src/operations/privacy';
import { main, recordIosCampaignPrivacy } from '../record-ios-campaign-privacy';
import { createScreenshotBackend, readScreenshotFixtureManifest } from '../lib/screenshot-backend';
import { createFixtureSnapshotArchive } from '../lib/screenshot-fixture-archive';
import {
  decodeFixtureSnapshot,
  snapshotHash,
  IOS_CAMPAIGN_FIXTURE_REFERENCE,
  FIXTURE_SNAPSHOT_REFERENCE,
} from '../lib/screenshot-fixture-snapshot';
import { emptyManifest, graphqlFixtureKey, type GraphqlFixtureFile } from '../lib/screenshot-fixtures';

const UPSTREAM = 'https://ws.boardsesh.com';
const EMAIL = 'shots@boardsesh.com';
const ACCOUNT_ID = '11111111-2222-4333-8444-555555555555';
const PASSWORD = 'secret-password-never-in-fixtures';
const JWT_PAYLOAD = Buffer.from(JSON.stringify({ sub: ACCOUNT_ID })).toString('base64url');
const JWT = `header.${JWT_PAYLOAD}.secret-live-signature`;
const REFRESH_TOKEN = 'secret-live-refresh-token';
const PRIVACY = {
  data: {
    privacySettings: {
      isPrivate: true,
      privacyRevision: 4,
      defaultSessionAudience: 'invite_only',
      anonymousOnForeignBoards: true,
      enabled: true,
    },
  },
};
const OLD_QUERY =
  'query PrivacySettings { privacySettings { isPrivate privacyRevision privacyOnboardingVersion defaultSessionAudience enabled } }';

let directory: string;
let baseDirectory: string;
let outputDirectory: string;
let upstream: Server;
let upstreamOrigin: string;
let authSubject: string;
let authStatus: number;
let graphqlStatus: number;
let graphqlResponse: unknown;
let sentQueries: unknown[];
let receivedCredentials: unknown[];
let closedModes: string[];
let openedPorts: number[];

function fixtureBytes(root: string): Record<string, Buffer> {
  const entries: Record<string, Buffer> = {};
  function visit(path: string, prefix = ''): void {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) visit(join(path, entry.name), `${relative}/`);
      else entries[relative] = readFileSync(join(path, entry.name));
    }
  }
  visit(root);
  return entries;
}

function makeBase(): void {
  const manifest = emptyManifest({
    recordedAt: '2026-09-19T14:00:00Z',
    frozenNow: '2026-09-19T14:01:00Z',
    upstream: UPSTREAM,
    accountEmail: EMAIL,
    accountUserId: ACCOUNT_ID,
    flow: 'app-store-campaign',
  });
  manifest.capture = {
    sharedSessionId: '00000000-0000-4000-8000-000000000101',
    profileSessionId: '00000000-0000-4000-8000-000000000102',
    boards: ['Kilter', 'Tension', 'MoonBoard', 'Woods', 'Decoy', 'Grasshopper', "Liz's Wall"],
  };
  manifest.approvedTestUserIds = ['22222222-3333-4444-8555-666666666666'];
  const replies = [
    {
      operationName: 'PrivacySettings',
      query: OLD_QUERY,
      response: {
        data: {
          privacySettings: {
            isPrivate: false,
            privacyRevision: 1,
            privacyOnboardingVersion: 0,
            defaultSessionAudience: 'public',
            enabled: true,
          },
        },
      },
    },
    {
      operationName: 'GetProfile',
      query: 'query GetProfile { profile { id email } }',
      response: { data: { profile: { id: ACCOUNT_ID, email: EMAIL } } },
    },
  ];
  for (const reply of replies) {
    const key = graphqlFixtureKey({ ...reply, variables: {} }, (text) => snapshotHash(Buffer.from(text)));
    const file = `graphql/${reply.operationName}/${key.variablesHash.slice(0, 16)}.json`;
    const fixture: GraphqlFixtureFile = {
      formatVersion: 1,
      ...reply,
      ...key,
      variables: {},
      status: 200,
      recordedAt: manifest.recordedAt,
      upstream: manifest.upstream,
    };
    mkdirSync(dirname(join(baseDirectory, file)), { recursive: true });
    writeFileSync(join(baseDirectory, file), JSON.stringify(fixture));
    manifest.graphql.push({
      operationName: reply.operationName,
      variablesHash: key.variablesHash,
      documentHash: key.documentHash,
      file,
    });
  }
  const photo = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
    'base64',
  );
  const hash = snapshotHash(photo);
  const file = `static/${hash}.png`;
  mkdirSync(join(baseDirectory, 'static'));
  writeFileSync(join(baseDirectory, file), photo);
  manifest.static.push({
    path: `/static/campaign-spray/${hash}.png`,
    query: '',
    file,
    contentType: 'image/png',
    bytes: photo.length,
  });
  writeFileSync(join(baseDirectory, 'manifest.json'), JSON.stringify(manifest));
}

const backendFactory: typeof createScreenshotBackend = (options) => {
  const backend = createScreenshotBackend(options);
  return {
    ...backend,
    listen: async (...args) => {
      const port = await backend.listen(...args);
      openedPorts.push(port);
      return port;
    },
    close: async () => {
      await backend.close();
      closedModes.push(options.mode);
    },
  };
};

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'campaign-privacy-test-'));
  baseDirectory = join(directory, 'base');
  outputDirectory = join(directory, 'candidate');
  mkdirSync(baseDirectory);
  makeBase();
  authSubject = ACCOUNT_ID;
  authStatus = 200;
  graphqlStatus = 200;
  graphqlResponse = PRIVACY;
  sentQueries = [];
  receivedCredentials = [];
  closedModes = [];
  openedPorts = [];
  upstream = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/auth/native/credentials') {
        receivedCredentials.push(JSON.parse(body));
        response.statusCode = authStatus;
        const jwt =
          authSubject === ACCOUNT_ID
            ? JWT
            : `header.${Buffer.from(JSON.stringify({ sub: authSubject })).toString('base64url')}.foreign-signature`;
        response.end(JSON.stringify({ jwt, refreshToken: REFRESH_TOKEN, message: PASSWORD }));
      } else {
        sentQueries.push({ body: JSON.parse(body), authorization: request.headers.authorization });
        response.statusCode = graphqlStatus;
        response.end(JSON.stringify(graphqlResponse));
      }
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('No upstream socket');
  upstreamOrigin = `http://127.0.0.1:${address.port}`;
  const originalFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    return originalFetch(url.startsWith(UPSTREAM) ? url.replace(UPSTREAM, upstreamOrigin) : input, init);
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())));
  rmSync(directory, { recursive: true, force: true });
});

async function refresh() {
  return recordIosCampaignPrivacy({ baseDirectory, outputDirectory, email: EMAIL, password: PASSWORD }, backendFactory);
}

async function assertSocketsClosed(): Promise<void> {
  for (const port of openedPorts) await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
}

describe('genuine Apple campaign privacy extension', () => {
  it('records the current query then replaces its whole fixture, preserving unrelated bytes and provenance', async () => {
    const originalFiles = fixtureBytes(baseDirectory);
    const originalPins = [IOS_CAMPAIGN_FIXTURE_REFERENCE, FIXTURE_SNAPSHOT_REFERENCE].map((filename) =>
      readFileSync(filename),
    );
    const result = await refresh();
    expect(sentQueries).toEqual([
      {
        body: { operationName: 'PrivacySettings', query: GET_PRIVACY_SETTINGS, variables: {} },
        authorization: `Bearer ${JWT}`,
      },
    ]);
    expect(receivedCredentials).toEqual([{ email: EMAIL, password: PASSWORD }]);
    const merged = join(outputDirectory, 'merged');
    const manifest = readScreenshotFixtureManifest(merged)!;
    const original = readScreenshotFixtureManifest(baseDirectory)!;
    expect(manifest.capture).toEqual(original.capture);
    expect(manifest.approvedTestUserIds).toEqual(original.approvedTestUserIds);
    expect(manifest.static).toEqual(original.static);
    expect(Date.parse(manifest.frozenNow)).toBeGreaterThan(Date.parse(original.frozenNow));
    const privacy = manifest.graphql.find((entry) => entry.operationName === 'PrivacySettings')!;
    const recorded = JSON.parse(readFileSync(join(merged, privacy.file), 'utf8')) as GraphqlFixtureFile;
    expect(recorded.query).toBe(GET_PRIVACY_SETTINGS);
    expect(recorded.response).toEqual(PRIVACY);
    expect(recorded.documentHash).not.toBe(original.graphql[0].documentHash);
    const extensionManifest = readScreenshotFixtureManifest(join(outputDirectory, 'recorded-extension'))!;
    expect(manifest.frozenNow).toBe(extensionManifest.frozenNow);
    expect(Date.parse(manifest.frozenNow)).toBeGreaterThan(Date.parse(recorded.recordedAt));
    expect(original.recordedAt).toBe('2026-09-19T14:00:00Z');
    for (const [index, filename] of [IOS_CAMPAIGN_FIXTURE_REFERENCE, FIXTURE_SNAPSHOT_REFERENCE].entries())
      expect(readFileSync(filename)).toEqual(originalPins[index]);
    for (const [file, bytes] of Object.entries(originalFiles)) {
      expect(readFileSync(join(baseDirectory, file))).toEqual(bytes);
      if (file !== 'manifest.json' && file !== privacy.file) expect(readFileSync(join(merged, file))).toEqual(bytes);
    }
    const archive = readFileSync(join(result.exportDirectory, 'campaign.json.gz'));
    const decoded = decodeFixtureSnapshot(archive, result.digest);
    expect(decoded.get(privacy.file)).toEqual(readFileSync(join(outputDirectory, 'recorded-extension', privacy.file)));
    for (const secret of [PASSWORD, JWT, JWT_PAYLOAD, REFRESH_TOKEN]) {
      for (const bytes of Object.values(fixtureBytes(outputDirectory))) expect(bytes.toString()).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    expect(result.proof).toMatchObject({
      unchangedGraphqlFiles: 1,
      unchangedStaticFiles: 1,
      originalBaseFilesPreserved: 4,
      unchangedCommittedPins: 2,
      currentDocumentReplayHits: 1,
      currentDocumentReplayMisses: 0,
      fullNativeReplayRequired: true,
    });
    expect(closedModes).toEqual(['record', 'replay']);
    await assertSocketsClosed();
  });

  it('refuses a real authenticated subject different from the original before querying privacy', async () => {
    authSubject = 'foreign-account';
    await expect(refresh()).rejects.toThrow('Authenticate the original screenshot account');
    expect(sentQueries).toEqual([]);
    expect(closedModes).toEqual(['record']);
    expect(existsSync(join(outputDirectory, 'export'))).toBe(false);
    await assertSocketsClosed();
  });

  it('rejects a caller email mismatch and unapproved upstream before sending credentials', async () => {
    await expect(
      recordIosCampaignPrivacy({ baseDirectory, outputDirectory, email: 'other@example.com', password: PASSWORD }),
    ).rejects.toThrow('Validate the original Apple campaign');
    const manifest = readScreenshotFixtureManifest(baseDirectory)!;
    manifest.upstream = 'https://unapproved.example';
    writeFileSync(join(baseDirectory, 'manifest.json'), JSON.stringify(manifest));
    await expect(refresh()).rejects.toThrow('Validate the original Apple campaign');
    expect(receivedCredentials).toEqual([]);
    expect(existsSync(outputDirectory)).toBe(false);
  });

  it.each(['auth', 'upstream', 'partial-error', 'missing-field', 'network', 'proxy-network'])(
    'fails closed and keeps token-safe errors with proper shutdown for %s',
    async (failure) => {
      if (failure === 'auth') authStatus = 401;
      if (failure === 'upstream') {
        graphqlStatus = 503;
        graphqlResponse = { error: `${PASSWORD} ${JWT} ${REFRESH_TOKEN}` };
      }
      if (failure === 'partial-error')
        graphqlResponse = { ...PRIVACY, errors: [{ message: `${PASSWORD} ${JWT} ${REFRESH_TOKEN}` }] };
      if (failure === 'missing-field') graphqlResponse = { data: { privacySettings: { enabled: true } } };
      if (failure === 'network' || failure === 'proxy-network') {
        const previousFetch = globalThis.fetch;
        vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
          const url = input instanceof Request ? input.url : String(input);
          if (
            url.endsWith('/auth/native/credentials') &&
            url.startsWith(failure === 'network' ? 'http://127.0.0.1:' : UPSTREAM)
          )
            throw new Error(`${PASSWORD} ${JWT} ${REFRESH_TOKEN}`);
          return previousFetch(input, init);
        });
      }
      let error: unknown;
      try {
        await refresh();
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      for (const secret of [PASSWORD, JWT, REFRESH_TOKEN]) expect(String(error)).not.toContain(secret);
      expect(existsSync(join(outputDirectory, 'export'))).toBe(false);
      expect(closedModes).toEqual(['record']);
      await assertSocketsClosed();
    },
  );

  it('refuses existing output without changing it', async () => {
    mkdirSync(outputDirectory);
    writeFileSync(join(outputDirectory, 'owned-by-someone-else'), 'preserve');
    await expect(refresh()).rejects.toThrow('Validate the original Apple campaign');
    expect(readFileSync(join(outputDirectory, 'owned-by-someone-else'), 'utf8')).toBe('preserve');
    expect(receivedCredentials).toEqual([]);
  });

  it('accepts no CLI operation, upstream, or command override before authenticating', async () => {
    const originalArgs = process.argv;
    process.argv = [
      'node',
      'record-ios-campaign-privacy.ts',
      '--query',
      'mutation DeleteSomething',
      '--upstream',
      'https://other.example',
    ];
    try {
      await expect(main()).rejects.toThrow('accepts no arguments');
      expect(receivedCredentials).toEqual([]);
      expect(existsSync(outputDirectory)).toBe(false);
    } finally {
      process.argv = originalArgs;
    }
  });

  it.each(['refs/heads/feature', 'refs/tags/main', ''])(
    'rejects CLI ref %s before fetching fixtures or exposing credentials',
    async (selectedRef) => {
      const originalArgs = process.argv;
      const request = vi.spyOn(globalThis, 'fetch');
      process.argv = ['node', 'record-ios-campaign-privacy.ts'];
      vi.stubEnv('RUNNER_TEMP', directory);
      vi.stubEnv('GITHUB_REF', selectedRef);
      try {
        await expect(main()).rejects.toThrow('requires the protected main workflow');
        expect(request).not.toHaveBeenCalled();
        expect(receivedCredentials).toEqual([]);
        expect(existsSync(outputDirectory)).toBe(false);
      } finally {
        request.mockRestore();
        process.argv = originalArgs;
      }
    },
  );

  it('honors the normal recorder token-refusal gate without exporting or persisting a live token', async () => {
    graphqlResponse = { ...PRIVACY, debug: JWT };
    await expect(refresh()).rejects.toThrow('Record the genuine current PrivacySettings');
    expect(existsSync(join(outputDirectory, 'export'))).toBe(false);
    for (const bytes of Object.values(fixtureBytes(outputDirectory))) expect(bytes.toString()).not.toContain(JWT);
    expect(closedModes).toEqual(['record']);
    await assertSocketsClosed();
  });

  it('refuses output inside the immutable original campaign', async () => {
    const original = fixtureBytes(baseDirectory);
    await expect(
      recordIosCampaignPrivacy({
        baseDirectory,
        outputDirectory: join(baseDirectory, 'extension'),
        email: EMAIL,
        password: PASSWORD,
      }),
    ).rejects.toThrow('Validate the original Apple campaign');
    expect(fixtureBytes(baseDirectory)).toEqual(original);
    expect(receivedCredentials).toEqual([]);
  });

  it('rejects corrupt original fixture hashes before authenticating', async () => {
    const manifest = readScreenshotFixtureManifest(baseDirectory)!;
    const file = join(baseDirectory, manifest.graphql[1].file);
    const recorded = JSON.parse(readFileSync(file, 'utf8')) as GraphqlFixtureFile;
    recorded.query = 'query GetProfile { profile { unexpectedField } }';
    writeFileSync(file, JSON.stringify(recorded));
    await expect(refresh()).rejects.toThrow('Validate the original Apple campaign');
    expect(receivedCredentials).toEqual([]);
    expect(existsSync(outputDirectory)).toBe(false);
  });

  it('preserves checksum-verified historical fixture provenance while strictly recording the new production response', async () => {
    const manifest = readScreenshotFixtureManifest(baseDirectory)!;
    const profile = manifest.graphql.find((entry) => entry.operationName === 'GetProfile')!;
    const file = join(baseDirectory, profile.file);
    const historical = JSON.parse(readFileSync(file, 'utf8')) as GraphqlFixtureFile;
    historical.upstream = 'local:historical-approved-campaign-source';
    writeFileSync(file, JSON.stringify(historical));
    const originalBytes = readFileSync(file);
    const originalArchive = createFixtureSnapshotArchive(baseDirectory);
    expect(decodeFixtureSnapshot(originalArchive.compressed, originalArchive.reference).get(profile.file)).toEqual(
      originalBytes,
    );
    const result = await refresh();
    const decoded = decodeFixtureSnapshot(
      readFileSync(join(result.exportDirectory, 'campaign.json.gz')),
      result.digest,
    );
    expect(decoded.get(profile.file)).toEqual(originalBytes);
    expect(readFileSync(file)).toEqual(originalBytes);
    const current = JSON.parse(decoded.get(result.proof.replacedFile)!.toString()) as GraphqlFixtureFile;
    expect(current.upstream).toBe(UPSTREAM);
    expect(readScreenshotFixtureManifest(join(outputDirectory, 'recorded-extension'))!.upstream).toBe(UPSTREAM);
  });

  it('rejects incomplete audience and nullable selected fields', async () => {
    graphqlResponse = {
      data: {
        privacySettings: {
          ...PRIVACY.data.privacySettings,
          defaultSessionAudience: 'members',
          anonymousOnForeignBoards: null,
        },
      },
    };
    await expect(refresh()).rejects.toThrow('Record the genuine current PrivacySettings');
    expect(existsSync(join(outputDirectory, 'export'))).toBe(false);
    await assertSocketsClosed();
  });

  it.each(['public', 'followers', 'only_me', 'unlisted', 'invite_only'])(
    'records the actual schema audience %s without substituting defaults',
    async (audience) => {
      graphqlResponse = {
        data: {
          privacySettings: { ...PRIVACY.data.privacySettings, defaultSessionAudience: audience, enabled: false },
        },
      };
      const result = await refresh();
      const decoded = decodeFixtureSnapshot(
        readFileSync(join(result.exportDirectory, 'campaign.json.gz')),
        result.digest,
      );
      const recorded = JSON.parse(decoded.get(result.proof.replacedFile)!.toString()) as GraphqlFixtureFile;
      expect(recorded.response).toEqual(graphqlResponse);
      expect(closedModes).toEqual(['record', 'replay']);
    },
  );

  it('fails candidate validation and closes replay when an unrelated merged fixture changes', async () => {
    const originalFiles = fixtureBytes(baseDirectory);
    const corruptingFactory: typeof createScreenshotBackend = (options) => {
      if (options.mode === 'replay') {
        const manifest = readScreenshotFixtureManifest(options.fixturesDir)!;
        const entry = manifest.graphql.find((fixture) => fixture.operationName === 'GetProfile')!;
        const path = join(options.fixturesDir, entry.file);
        const recorded = JSON.parse(readFileSync(path, 'utf8')) as GraphqlFixtureFile;
        recorded.documentHash = '0'.repeat(64);
        writeFileSync(path, JSON.stringify(recorded));
      }
      return backendFactory(options);
    };
    await expect(
      recordIosCampaignPrivacy({ baseDirectory, outputDirectory, email: EMAIL, password: PASSWORD }, corruptingFactory),
    ).rejects.toThrow('Validate current PrivacySettings replay');
    expect(closedModes).toEqual(['record', 'replay']);
    expect(existsSync(join(outputDirectory, 'export'))).toBe(false);
    expect(fixtureBytes(baseDirectory)).toEqual(originalFiles);
    await assertSocketsClosed();
  });
});

describe('fixed manual campaign extension workflow', () => {
  it('accepts no arbitrary inputs and only exports the candidate artifact with read-only permissions', () => {
    const source = readFileSync('.github/workflows/mobile-screenshot-campaign-fixtures.yml', 'utf8');
    const workflow = parse(source) as {
      on: Record<string, unknown>;
      permissions: Record<string, string>;
      jobs: Record<
        string,
        {
          if: string;
          environment: string;
          steps: Array<{
            name?: string;
            run?: string;
            uses?: string;
            env?: Record<string, string>;
            with?: Record<string, string | boolean>;
          }>;
        }
      >;
    };
    expect(workflow.on).toEqual({ workflow_dispatch: null });
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(workflow.jobs)).toEqual(['record-privacy']);
    const job = workflow.jobs['record-privacy'];
    expect(job.if).toBe("${{ github.ref == 'refs/heads/main' && github.ref_protected }}");
    expect(job.environment).toBe('Production');
    const steps = job.steps;
    expect(steps[0].with?.ref).toBe('${{ github.sha }}');
    expect(steps[0].with?.['persist-credentials']).toBe(false);
    const checkoutGuard = steps.findIndex(
      (step) => step.name === 'Verify protected main checkout before exposing credentials',
    );
    const credentialStep = steps.findIndex((step) => step.env?.SCREENSHOT_USER_PASSWORD);
    expect(checkoutGuard).toBeGreaterThan(0);
    expect(checkoutGuard).toBeLessThan(credentialStep);
    expect(steps[checkoutGuard].run).toContain('test "$GITHUB_REF" = refs/heads/main');
    expect(steps[checkoutGuard].run).toContain('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"');
    expect(steps[checkoutGuard].run).not.toContain('persist-credentials');
    const guardScript = steps[checkoutGuard].run;
    if (!guardScript) throw new Error('Checkout guard is missing');
    const checkedOutCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const guardEnvironment = { ...process.env, GITHUB_REF: 'refs/heads/main', GITHUB_SHA: checkedOutCommit };
    expect(execFileSync('bash', ['-c', guardScript], { env: guardEnvironment, encoding: 'utf8' })).toBe('');
    for (const invalidEnvironment of [
      { ...guardEnvironment, GITHUB_REF: 'refs/heads/feature' },
      { ...guardEnvironment, GITHUB_REF: 'refs/tags/main' },
      { ...guardEnvironment, GITHUB_SHA: '0'.repeat(40) },
    ]) {
      expect(() => execFileSync('bash', ['-c', guardScript], { env: invalidEnvironment, stdio: 'pipe' })).toThrow();
    }
    expect(steps.filter((step) => step.run).map((step) => step.run)).toEqual([
      steps[checkoutGuard].run,
      'vp install --frozen-lockfile',
      'vp exec node --import tsx scripts/record-ios-campaign-privacy.ts',
    ]);
    expect(steps.filter((step) => step.env)).toHaveLength(1);
    expect(steps.find((step) => step.env)?.env).toEqual({
      SCREENSHOT_USER_EMAIL: '${{ secrets.SCREENSHOT_USER_EMAIL }}',
      SCREENSHOT_USER_PASSWORD: '${{ secrets.SCREENSHOT_USER_PASSWORD }}',
    });
    expect(steps.at(-1)?.uses).toBe('actions/upload-artifact@v4');
    expect(steps.at(-1)?.with?.path).toBe('${{ runner.temp }}/ios-campaign-privacy-candidate/export/');
    expect(steps.at(-1)?.with?.['if-no-files-found']).toBe('error');
    expect(source).not.toMatch(/gh release|fastlane|contents: write|git push|reference-url|inputs\./);
  });
});
