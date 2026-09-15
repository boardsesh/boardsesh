/// <reference types="node" />

// The one-off rewrite of an already-recorded set. Everything here guards the
// same property: it must change the RESPONSES and nothing else. A fixture is
// keyed by its document and variables, so a rewrite that touched a hash, a
// filename or a manifest entry would silently un-key the whole set and every
// replay would miss.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parsePseudonymiseArguments, pseudonymiseFixtureSet } from '../screenshot-fixtures-pseudonymise';
import { readScreenshotFixtureManifest } from '../lib/screenshot-backend';
import {
  DEFAULT_SCREENSHOT_FIXTURES_DIR,
  emptyManifest,
  pseudonymDisplayName,
  pseudonymHandle,
  type GraphqlFixtureFile,
  type ScreenshotFixtureManifest,
} from '../lib/screenshot-fixtures';

const ACCOUNT_USER_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_USER_ID = '22222222-2222-2222-2222-222222222222';

const FEED_FIXTURE: GraphqlFixtureFile = {
  formatVersion: 1,
  operationName: 'GetSessionGroupedFeed',
  documentHash: 'd'.repeat(64),
  variablesHash: 'a'.repeat(64),
  query: 'query GetSessionGroupedFeed { sessionGroupedFeed { sessions { sessionId } } }',
  variables: { input: { scope: 'everyone' } },
  response: {
    data: {
      sessionGroupedFeed: {
        sessions: [
          {
            sessionId: 's1',
            sessionName: 'Tuesday session',
            participants: [
              { userId: ACCOUNT_USER_ID, displayName: 'Test User', avatarUrl: 'https://cdn/own.jpg' },
              { userId: OTHER_USER_ID, displayName: 'Xin Wei Chow', avatarUrl: 'https://cdn/xin.jpg' },
            ],
            featuredBeta: { betaLink: { climbUuid: 'c1', foreignUsername: 'kilter.kroz' } },
          },
        ],
      },
    },
  },
  status: 200,
  recordedAt: '2026-09-15T15:00:00.000Z',
  upstream: 'https://ws.boardsesh.com',
};

function writeSet(fixturesDir: string, statics: ScreenshotFixtureManifest['static'] = []): ScreenshotFixtureManifest {
  const manifest = emptyManifest({
    recordedAt: '2026-09-15T15:00:00.000Z',
    frozenNow: '2026-09-15T15:00:01Z',
    upstream: 'https://ws.boardsesh.com',
    accountEmail: 'test@boardsesh.com',
    accountUserId: ACCOUNT_USER_ID,
    flow: 'app-store',
  });
  const file = 'graphql/GetSessionGroupedFeed/aaaaaaaaaaaaaaaa.json';
  mkdirSync(join(fixturesDir, 'graphql', 'GetSessionGroupedFeed'), { recursive: true });
  writeFileSync(join(fixturesDir, file), `${JSON.stringify(FEED_FIXTURE, null, 2)}\n`);
  manifest.graphql.push({
    operationName: FEED_FIXTURE.operationName,
    documentHash: FEED_FIXTURE.documentHash,
    variablesHash: FEED_FIXTURE.variablesHash,
    file,
  });
  for (const entry of statics) {
    mkdirSync(join(fixturesDir, 'static'), { recursive: true });
    writeFileSync(join(fixturesDir, entry.file), 'fake-bytes');
    manifest.static.push(entry);
  }
  writeFileSync(join(fixturesDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

describe('pseudonymiseFixtureSet', () => {
  let fixturesDir: string;

  beforeEach(() => {
    fixturesDir = mkdtempSync(join(tmpdir(), 'pseudonymise-fixtures-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(fixturesDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const readFixture = (file: string): GraphqlFixtureFile =>
    JSON.parse(readFileSync(join(fixturesDir, file), 'utf8')) as GraphqlFixtureFile;

  it('rewrites only the response, leaving the key, the query and the variables byte-identical', () => {
    const manifest = writeSet(fixturesDir);
    const result = pseudonymiseFixtureSet(fixturesDir, manifest, { dryRun: false });

    expect(result.rewrittenFixtures).toBe(1);
    expect(result.personRewrites).toBe(2);
    expect(result.fieldRewrites).toBe(3);

    const rewritten = readFixture(manifest.graphql[0].file);
    expect(rewritten.documentHash).toBe(FEED_FIXTURE.documentHash);
    expect(rewritten.variablesHash).toBe(FEED_FIXTURE.variablesHash);
    expect(rewritten.query).toBe(FEED_FIXTURE.query);
    expect(rewritten.variables).toEqual(FEED_FIXTURE.variables);
    expect(rewritten.recordedAt).toBe(FEED_FIXTURE.recordedAt);

    const session = (
      rewritten.response as {
        data: {
          sessionGroupedFeed: {
            sessions: {
              sessionName: string;
              participants: Record<string, unknown>[];
              featuredBeta: { betaLink: { foreignUsername: string } };
            }[];
          };
        };
      }
    ).data.sessionGroupedFeed.sessions[0];
    expect(session.participants[0]).toEqual({
      userId: ACCOUNT_USER_ID,
      displayName: 'Test User',
      avatarUrl: 'https://cdn/own.jpg',
    });
    expect(session.participants[1]).toEqual({
      userId: OTHER_USER_ID,
      displayName: pseudonymDisplayName(OTHER_USER_ID),
      avatarUrl: null,
    });
    expect(session.featuredBeta.betaLink.foreignUsername).toBe(pseudonymHandle('kilter.kroz'));
    // A session's own name is not a person's name.
    expect(session.sessionName).toBe('Tuesday session');
  });

  it('leaves the manifest untouched when the set holds no static avatar', () => {
    const manifest = writeSet(fixturesDir);
    const before = readFileSync(join(fixturesDir, 'manifest.json'), 'utf8');
    pseudonymiseFixtureSet(fixturesDir, manifest, { dryRun: false });
    expect(readFileSync(join(fixturesDir, 'manifest.json'), 'utf8')).toBe(before);
  });

  it('drops a static avatar and its file — a null avatar URL is never requested again', () => {
    const manifest = writeSet(fixturesDir, [
      {
        path: '/static/avatars/someone.jpg',
        query: 'size=128',
        file: 'static/aaaa.jpg',
        contentType: 'image/jpeg',
        bytes: 10,
      },
      {
        path: '/static/beta-link-thumbnails/instagram/Xyz.jpg',
        query: 'size=280',
        file: 'static/bbbb.jpg',
        contentType: 'image/jpeg',
        bytes: 10,
      },
    ]);
    const result = pseudonymiseFixtureSet(fixturesDir, manifest, { dryRun: false });
    expect(result.removedStaticAvatars).toEqual(['static/aaaa.jpg']);
    const rewritten = readScreenshotFixtureManifest(fixturesDir);
    expect(rewritten?.static.map((entry) => entry.file)).toEqual(['static/bbbb.jpg']);
    expect(() => readFileSync(join(fixturesDir, 'static/aaaa.jpg'))).toThrow();
    // The beta thumbnail stays: its link is still in the fixture set.
    expect(readFileSync(join(fixturesDir, 'static/bbbb.jpg'), 'utf8')).toBe('fake-bytes');
  });

  it('is idempotent — a second run rewrites nothing and the bytes do not move', () => {
    const manifest = writeSet(fixturesDir);
    pseudonymiseFixtureSet(fixturesDir, manifest, { dryRun: false });
    const afterFirst = readFileSync(join(fixturesDir, manifest.graphql[0].file), 'utf8');
    const second = pseudonymiseFixtureSet(fixturesDir, manifest, { dryRun: false });
    expect(second.rewrittenFixtures).toBe(0);
    expect(second.fieldRewrites).toBe(0);
    expect(readFileSync(join(fixturesDir, manifest.graphql[0].file), 'utf8')).toBe(afterFirst);
  });

  it('writes nothing under --check but still reports what it found', () => {
    const manifest = writeSet(fixturesDir);
    const before = readFileSync(join(fixturesDir, manifest.graphql[0].file), 'utf8');
    const result = pseudonymiseFixtureSet(fixturesDir, manifest, { dryRun: true });
    expect(result.fieldRewrites).toBe(3);
    expect(readFileSync(join(fixturesDir, manifest.graphql[0].file), 'utf8')).toBe(before);
  });
});

describe('parsePseudonymiseArguments', () => {
  it('defaults to the committed set and a real rewrite', () => {
    const options = parsePseudonymiseArguments([]);
    expect(options.fixturesDir.endsWith(DEFAULT_SCREENSHOT_FIXTURES_DIR)).toBe(true);
    expect(options.dryRun).toBe(false);
  });

  it('skips the literal `--` vp run inserts ahead of every flag', () => {
    expect(parsePseudonymiseArguments(['--', '--check']).dryRun).toBe(true);
  });

  it('takes an absolute --dir as given and resolves a relative one against the repo root', () => {
    expect(parsePseudonymiseArguments(['--dir', '/tmp/somewhere']).fixturesDir).toBe('/tmp/somewhere');
    expect(parsePseudonymiseArguments(['--dir', 'artifacts/set']).fixturesDir).toMatch(/\/artifacts\/set$/);
  });

  it('fails loudly on a missing value and on an unknown flag', () => {
    expect(() => parsePseudonymiseArguments(['--dir'])).toThrow(/--dir needs a value/);
    expect(() => parsePseudonymiseArguments(['--bogus'])).toThrow(/unknown argument --bogus/);
  });
});
