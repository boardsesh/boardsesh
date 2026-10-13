import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET_MY_BOARDS } from '../../packages/shared/graphql/src/operations/boards';
import { SEARCH_CLIMBS_COUNT } from '../../packages/shared/graphql/src/operations/climb-search';
import {
  assertCppGradeCountProof,
  bindCppGradeCountProof,
  cppGradeCountKey,
  cppRecordedCountSelector,
  resolveCppGradeCountProof,
  readCppCountFixtures,
} from '../lib/cpp-grade-count';
import { graphqlFixtureKey, type GraphqlFixtureFile, type ScreenshotFixtureManifest } from '../lib/screenshot-fixtures';
import { buildReadinessServerScript } from '../lib/metro-dev-server';
import { createScreenshotBackend, readScreenshotFixtureManifest } from '../lib/screenshot-backend';
import { graphqlFixtureContentHash, mergeFixtureSets, type FixtureSetForMerge } from '../screenshot-fixtures-merge';
import { renderCppMaestroFlow, cppGradeFilterSelectors, IOS_SCREENSHOT_DEVICES } from '../mobile-screenshots';
import { readCppPage } from '../lib/screenshot-cpp';
import { parseAllDocuments } from 'yaml';

const accountId = 'fbb773f8-5bec-473e-8216-e34ca55b073b';
const boardId = 'beb1595e-11d1-44fa-9de6-e55a5b9aaa97';
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
function sample() {
  const manifest: ScreenshotFixtureManifest = {
    formatVersion: 1,
    flow: 'app-store-cpp',
    accountEmail: 'shots@example.test',
    accountUserId: accountId,
    upstream: 'https://ws.boardsesh.com',
    frozenNow: '2026-10-13T00:50:00Z',
    recordedAt: '2026-10-13T00:50:00Z',
    graphql: [],
    static: [],
    capture: {
      sharedSessionId: '78ee9133-0000-4000-8000-000000000001',
      boards: ['Liz Kilter', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth'],
      cpp: {
        target: 'kilter',
        boardIds: { 'kilter-original-12x12': boardId },
        boardReadyText: {},
        scenes: {
          search: {
            boardId,
            readyText: 'Filters',
            gradeFilter: { minLabel: 'V1', maxLabel: 'V3', minGradeId: 13, maxGradeId: 16, expectedCount: 12976 },
          },
        },
      },
    },
  };
  const variables = { input: { limit: 50, offset: 0 } };
  const roster: GraphqlFixtureFile = {
    formatVersion: 1,
    ...graphqlFixtureKey({ operationName: 'GetMyBoards', query: GET_MY_BOARDS, variables }, sha256),
    query: GET_MY_BOARDS,
    variables,
    status: 200,
    upstream: manifest.upstream,
    recordedAt: manifest.recordedAt,
    response: {
      data: {
        myBoards: {
          boards: [
            {
              uuid: boardId,
              ownerId: accountId,
              name: 'Liz Kilter',
              boardType: 'kilter',
              layoutId: 1,
              sizeId: 10,
              setIds: '1,20',
              angle: 40,
            },
          ],
        },
      },
    },
  };
  const entryFor = (fixture: GraphqlFixtureFile) => ({
    operationName: fixture.operationName,
    documentHash: fixture.documentHash,
    variablesHash: fixture.variablesHash,
    file: `graphql/${fixture.operationName}/${fixture.variablesHash.slice(0, 16)}.json`,
  });
  manifest.graphql = [entryFor(roster)];
  const key = cppGradeCountKey(manifest, [roster]);
  const count: GraphqlFixtureFile = {
    formatVersion: 1,
    ...key,
    query: SEARCH_CLIMBS_COUNT,
    status: 200,
    upstream: manifest.upstream,
    recordedAt: '2026-10-13T00:56:24.019Z',
    response: { data: { searchClimbs: { totalCount: 12985 } } },
  };
  manifest.graphql.push(entryFor(count));
  return { manifest, roster, count };
}
const temporaryDirectories: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('genuine CPP grade-count provenance', () => {
  it('adds a genuine dynamic selector only to recording; legacy and replay flow bytes stay unchanged', () => {
    const coverage = sample().manifest.capture!.cpp!;
    const page = readCppPage('kilter');
    for (const variant of [...page.heroBoards, ...page.otherBoards]) {
      coverage.boardReadyText[variant.id] = `Real ${variant.id}`;
      coverage.boardNames ??= {};
      coverage.boardNames[variant.id] = variant.selector;
      coverage.boardIds![variant.id] ??= boardId;
    }
    for (const scene of ['logbook', 'led', 'queue', 'workout', 'status', 'island'])
      coverage.scenes[scene] = {
        boardId,
        readyText: 'Actual climb',
        ascentId: '543c1c0c-3a22-4640-b30d-6cab80738bc3',
        climbId: 'D0E5387D5B974D38B4E93FC4DFD61EF6',
        sessionId: sample().manifest.capture!.sharedSessionId,
      };
    for (const locale of ['en-US', 'es', 'fr', 'de'] as const) {
      for (const device of IOS_SCREENSHOT_DEVICES) {
        const legacy = renderCppMaestroFlow('kilter', device, coverage, locale);
        expect(renderCppMaestroFlow('kilter', device, coverage, locale, false)).toBe(legacy);
        expect(legacy).not.toContain('/grade-count?');
        const recording = renderCppMaestroFlow('kilter', device, coverage, locale, true);
        expect(recording).toContain(`/grade-count?sequence=' + output.cppSequence + '&locale=${locale}`);
        expect(recording).toContain('visible: ${output.cppGradeCount.selector}');
        expect(recording).toContain('/set?scene=search-grade');
        expect(recording).toContain(cppGradeFilterSelectors(coverage.scenes.search.gradeFilter!, locale).minSelected);
        expect(parseAllDocuments(recording).every((document) => document.errors.length === 0)).toBe(true);
      }
    }
    delete coverage.scenes.search.gradeFilter;
    expect(renderCppMaestroFlow('kilter', IOS_SCREENSHOT_DEVICES[0], coverage, 'en-US', true)).toBe(
      renderCppMaestroFlow('kilter', IOS_SCREENSHOT_DEVICES[0], coverage),
    );
  });
  it('rebinds 12976 bootstrap to exact native recorded 12985 and keeps replay exact', () => {
    const { manifest, roster, count } = sample();
    const bound = bindCppGradeCountProof(manifest, [roster, count]);
    expect(bound.capture!.cpp!.scenes.search.gradeFilter!.expectedCount).toBe(12985);
    expect(bound.capture!.cpp!.scenes.search.gradeFilter!.proof).toEqual(
      resolveCppGradeCountProof(manifest, [roster, count]),
    );
    expect(() => assertCppGradeCountProof(bound, [roster, count])).not.toThrow();
    expect(() => assertCppGradeCountProof(manifest, [roster, count])).toThrow(/metadata differs/);
    expect(manifest.capture!.cpp!.scenes.search.gradeFilter!.expectedCount).toBe(12976);
    expect(cppRecordedCountSelector(12985, 'en-US')).toContain('12,985');
    expect(cppRecordedCountSelector(12985, 'en-US')).not.toContain('12,976');
  });
  it.each(['en-US', 'es', 'fr', 'de'] as const)('matches the actual localized flow count selector for %s', (locale) => {
    const grade = sample().manifest.capture!.cpp!.scenes.search.gradeFilter!;
    expect(cppRecordedCountSelector(12976, locale)).toBe(cppGradeFilterSelectors(grade, locale).count);
  });
  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('rejects invalid API count %s', (totalCount) => {
    const { manifest, roster, count } = sample();
    count.response = { data: { searchClimbs: { totalCount } } };
    expect(() => resolveCppGradeCountProof(manifest, [roster, count])).toThrow(/verification/);
  });
  it.each(['layoutId', 'sizeId', 'angle', 'minGrade', 'maxGrade', 'pageSize', 'boulders'] as const)(
    'rejects even one changed native input field: %s',
    (field) => {
      const { manifest, roster, count } = sample();
      const variables = count.variables as { input: Record<string, unknown> };
      variables.input[field] = field === 'boulders' ? false : 99;
      expect(() => resolveCppGradeCountProof(manifest, [roster, count])).toThrow(/verification/);
    },
  );
  it.each(['status', 'query', 'documentHash', 'upstream', 'recordedAt'] as const)(
    'rejects corrupt response provenance: %s',
    (field) => {
      const { manifest, roster, count } = sample();
      const corrupted = { ...count, [field]: field === 'status' ? 500 : 'wrong' };
      expect(() => resolveCppGradeCountProof(manifest, [roster, corrupted])).toThrow(/verification/);
    },
  );
  it.each(['file', 'documentHash', 'variablesHash', 'operationName'] as const)(
    'rejects a manifest index that misidentifies the actual count: %s',
    (field) => {
      const { manifest, roster, count } = sample();
      manifest.graphql[1][field] = field === 'file' ? 'graphql/SearchClimbsCount/0000000000000000.json' : 'wrong';
      expect(() => resolveCppGradeCountProof(manifest, [roster, count])).toThrow(/index/);
    },
  );
  it('rejects missing/errored count responses and a different primary UUID or target geometry', () => {
    const { manifest, roster, count } = sample();
    expect(() => resolveCppGradeCountProof(manifest, [roster, { ...count, response: null }])).toThrow(/verification/);
    const coverage = manifest.capture!.cpp!;
    coverage.scenes.search.boardId = 'a58c46ed-afb0-4fe2-8d41-2e87d8e4db51';
    expect(() => resolveCppGradeCountProof(manifest, [roster, count])).toThrow(/UUID/);
    coverage.scenes.search.boardId = boardId;
    const response = roster.response as { data: { myBoards: { boards: Array<{ layoutId: number }> } } };
    response.data.myBoards.boards[0].layoutId = 8;
    expect(() => resolveCppGradeCountProof(manifest, [roster, count])).toThrow(/configuration/);
  });
  it('rejects a real count JSON stored under a different manifest-listed filename', () => {
    const { manifest, roster, count } = sample();
    const directory = mkdtempSync(join(tmpdir(), 'cpp-count-index-'));
    temporaryDirectories.push(directory);
    manifest.graphql[1].file = 'graphql/SearchClimbsCount/0000000000000000.json';
    for (const [index, fixture] of [roster, count].entries()) {
      const entry = manifest.graphql[index];
      mkdirSync(join(directory, 'graphql', entry.operationName), { recursive: true });
      writeFileSync(join(directory, entry.file), JSON.stringify(fixture));
    }
    expect(() => readCppCountFixtures(directory, manifest)).toThrow(/index/);
  });
  it('rejects GraphQL errors, missing matching recording, wrong owner and forged proof', () => {
    const { manifest, roster, count } = sample();
    expect(() =>
      resolveCppGradeCountProof(manifest, [
        roster,
        { ...count, response: { errors: [{ message: 'failed' }], data: { searchClimbs: { totalCount: 12985 } } } },
      ]),
    ).toThrow();
    expect(() => resolveCppGradeCountProof(manifest, [roster])).toThrow(/missing/);
    expect(() => resolveCppGradeCountProof({ ...manifest, accountUserId: 'different' }, [roster, count])).toThrow(
      /owned/,
    );
    const bound = bindCppGradeCountProof(manifest, [roster, count]);
    bound.capture!.cpp!.scenes.search.gradeFilter!.proof!.responseSha256 = '0'.repeat(64);
    expect(() => assertCppGradeCountProof(bound, [roster, count])).toThrow(/metadata differs/);
    expect(() => cppRecordedCountSelector(12985, 'it')).toThrow(/locale/);
  });
});

function mergeSet(label: string, totalCount: number, recordedAt: string): FixtureSetForMerge {
  const { manifest, roster, count } = sample();
  count.response = { data: { searchClimbs: { totalCount } } };
  count.recordedAt = recordedAt;
  const bound = bindCppGradeCountProof(manifest, [roster, count]);
  const fixtures = [roster, count];
  bound.graphql = fixtures.map((fixture) => ({
    operationName: fixture.operationName,
    documentHash: fixture.documentHash,
    variablesHash: fixture.variablesHash,
    file: `graphql/${fixture.operationName}/${fixture.variablesHash.slice(0, 16)}.json`,
  }));
  return {
    label,
    manifest: bound,
    cppCountFixtures: fixtures,
    contentHashes: new Map(
      bound.graphql.map((entry, index) => [entry.file, graphqlFixtureContentHash(fixtures[index])]),
    ),
    graphqlRecordedAt: new Map(bound.graphql.map((entry, index) => [entry.file, fixtures[index].recordedAt])),
  };
}
describe('CPP count merge uses only the genuine winning response', () => {
  it('accepts an additional valid roster page from the newer source and proves the actual merged files', () => {
    const early = mergeSet('early', 12976, '2026-10-13T00:50:00Z');
    const later = mergeSet('later', 12985, '2026-10-13T00:56:24Z');
    const variables = { input: { limit: 50, offset: 50 } };
    const extraRoster: GraphqlFixtureFile = {
      ...later.cppCountFixtures![0],
      ...graphqlFixtureKey({ operationName: 'GetMyBoards', query: GET_MY_BOARDS, variables }, sha256),
      variables,
      response: { data: { myBoards: { boards: [] } } },
      recordedAt: '2026-10-13T00:56:20Z',
    };
    const entry = {
      operationName: extraRoster.operationName,
      documentHash: extraRoster.documentHash,
      variablesHash: extraRoster.variablesHash,
      file: `graphql/GetMyBoards/${extraRoster.variablesHash.slice(0, 16)}.json`,
    };
    later.manifest.graphql.push(entry);
    later.cppCountFixtures = [...later.cppCountFixtures!, extraRoster];
    later.contentHashes = new Map([...later.contentHashes, [entry.file, graphqlFixtureContentHash(extraRoster)]]);
    later.graphqlRecordedAt = new Map([...later.graphqlRecordedAt!, [entry.file, extraRoster.recordedAt]]);
    expect(() => assertCppGradeCountProof(later.manifest, later.cppCountFixtures!)).not.toThrow();
    const merged = mergeFixtureSets([early, later], { onConflict: 'newest' });
    expect(merged.manifest.graphql).toContainEqual(entry);
    expect(merged.sources.get(entry.file)).toBe('later');
    expect(merged.manifest.capture!.cpp!.scenes.search.gradeFilter).toEqual(
      later.manifest.capture!.cpp!.scenes.search.gradeFilter,
    );
    expect(() =>
      assertCppGradeCountProof(merged.manifest, [early.cppCountFixtures![0], later.cppCountFixtures![1], extraRoster]),
    ).not.toThrow();
  });
  it('rejects a winning source whose supplied content hash misidentifies its actual fixture', () => {
    const early = mergeSet('early', 12976, '2026-10-13T00:50:00Z');
    const later = mergeSet('later', 12985, '2026-10-13T00:56:24Z');
    const file = later.manifest.capture!.cpp!.scenes.search.gradeFilter!.proof!.file;
    later.contentHashes = new Map([...later.contentHashes, [file, 'different-content']]);
    expect(() => mergeFixtureSets([early, later], { onConflict: 'newest' })).toThrow(/genuine source/);
  });
  it('default rejects real drift; newest keeps exact count, proof and immutable winning bytes', () => {
    const early = mergeSet('early', 12976, '2026-10-13T00:50:00Z');
    const later = mergeSet('later', 12985, '2026-10-13T00:56:24Z');
    expect(() => mergeFixtureSets([early, later])).toThrow(/different|conflict/);
    const merged = mergeFixtureSets([early, later], { onConflict: 'newest' });
    expect(merged.manifest.capture!.cpp!.scenes.search.gradeFilter).toEqual(
      later.manifest.capture!.cpp!.scenes.search.gradeFilter,
    );
    const proof = merged.manifest.capture!.cpp!.scenes.search.gradeFilter!.proof!;
    expect(merged.sources.get(proof.file)).toBe('later');
    expect(merged.manifest.capture!.boards).toEqual(early.manifest.capture!.boards);
    expect(merged.manifest.accountUserId).toBe(accountId);
    expect(merged.conflicts).toHaveLength(1);
    expect(later.cppCountFixtures![1].response).toEqual({ data: { searchClimbs: { totalCount: 12985 } } });
  });
  it('still rejects every other capture identity difference and dishonest count metadata', () => {
    const early = mergeSet('early', 12976, '2026-10-13T00:50:00Z');
    const later = mergeSet('later', 12985, '2026-10-13T00:56:24Z');
    later.manifest.capture!.cpp!.scenes.search.readyText = 'Different';
    expect(() => mergeFixtureSets([early, later], { onConflict: 'newest' })).toThrow(/capture scenarios/);
    later.manifest.capture!.cpp!.scenes.search.readyText = 'Filters';
    later.manifest.capture!.cpp!.scenes.search.gradeFilter!.expectedCount = 12986;
    expect(() => mergeFixtureSets([early, later], { onConflict: 'newest' })).toThrow(/metadata differs/);
  });
});

describe('actual recording transport', () => {
  it.each(['fetch-error', 'body-error', 'ordinary-fetch-error'] as const)(
    'keeps %s outcomes while reporting only safe CPP transport details',
    async (phase) => {
      const { manifest, count } = sample();
      const directory = mkdtempSync(join(tmpdir(), 'cpp-upstream-'));
      temporaryDirectories.push(directory);
      const origin = 'http://127.0.0.1:19999';
      manifest.upstream = origin;
      manifest.graphql = [];
      if (phase === 'ordinary-fetch-error') manifest.flow = 'app-store';
      writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
      const realFetch = globalThis.fetch;
      const error = Object.assign(new Error('secret-password-and-url'), { code: 'ECONNRESET' });
      vi.stubGlobal('fetch', async (url: string | URL | Request, options?: RequestInit) => {
        if ((typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).startsWith(origin)) {
          if (phase !== 'body-error') throw error;
          const response = new Response('', { status: 200 });
          response.text = async () => {
            throw error;
          };
          return response;
        }
        return realFetch(url, options);
      });
      const logs: string[] = [];
      const backend = createScreenshotBackend({
        mode: 'record',
        fixturesDir: directory,
        upstreamUrl: origin,
        frozenNow: manifest.frozenNow,
        flow: manifest.flow,
        log: (line) => logs.push(line),
      });
      try {
        const port = await backend.listen(0, '127.0.0.1');
        const response = await realFetch(`http://127.0.0.1:${port}/graphql`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ operationName: count.operationName, query: count.query, variables: count.variables }),
        });
        expect(response.status).toBe(500);
        await response.text();
        const diagnostics = logs.filter((line) => line.includes('CPP-UPSTREAM'));
        if (phase === 'ordinary-fetch-error') expect(diagnostics).toEqual([]);
        else {
          expect(diagnostics).toHaveLength(1);
          expect(diagnostics[0]).toContain(`phase=${phase}`);
          expect(diagnostics[0]).toContain('codes=ECONNRESET');
          expect(diagnostics[0]).toContain(`variablesHash=${count.variablesHash}`);
          expect(diagnostics[0]).not.toMatch(/secret-password|http:|shots@example/);
        }
        expect(readScreenshotFixtureManifest(directory)!.graphql).toEqual([]);
      } finally {
        await backend.close();
      }
    },
  );
  it('records the terminal actual response after a CPP client closes, without cancelling or retrying its upstream request', async () => {
    const { manifest } = sample();
    const directory = mkdtempSync(join(tmpdir(), 'cpp-upstream-closed-'));
    temporaryDirectories.push(directory);
    const origin = 'http://127.0.0.1:19998';
    manifest.upstream = origin;
    manifest.graphql = [];
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
    const realFetch = globalThis.fetch;
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let upstreamCalls = 0;
    vi.stubGlobal('fetch', async (url: string | URL | Request, options?: RequestInit) => {
      if ((typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).startsWith(origin)) {
        upstreamCalls += 1;
        entered!();
        await pending;
        return new Response(JSON.stringify({ data: { grades: [] } }), { status: 200 });
      }
      return realFetch(url, options);
    });
    const logs: string[] = [];
    const backend = createScreenshotBackend({
      mode: 'record',
      fixturesDir: directory,
      upstreamUrl: origin,
      frozenNow: manifest.frozenNow,
      flow: 'app-store-cpp',
      log: (line) => logs.push(line),
    });
    try {
      const port = await backend.listen(0, '127.0.0.1');
      const controller = new AbortController();
      const request = realFetch(`http://127.0.0.1:${port}/graphql`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operationName: 'GetGrades',
          query: 'query GetGrades { grades { name } }',
          variables: {},
        }),
      }).catch(() => undefined);
      await started;
      controller.abort();
      await request;
      await vi.waitFor(() => expect(logs.some((line) => line.includes('phase=client-closed'))).toBe(true));
      release!();
      await vi.waitFor(() =>
        expect(logs.some((line) => line.includes('phase=response') && line.includes('status=200'))).toBe(true),
      );
      expect(upstreamCalls).toBe(1);
      expect(readScreenshotFixtureManifest(directory)!.graphql[0].operationName).toBe('GetGrades');
      expect(logs.filter((line) => line.includes('phase=client-closed'))).toHaveLength(1);
    } finally {
      release!();
      await backend.close();
    }
  });
  it('persists a real local upstream count and fails closed when that same key changes, retaining first bytes', async () => {
    const { manifest, roster, count } = sample();
    let totalCount = 12985;
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: { searchClimbs: { totalCount } } }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('No local upstream');
    const origin = `http://127.0.0.1:${address.port}`;
    const directory = mkdtempSync(join(tmpdir(), 'cpp-count-'));
    temporaryDirectories.push(directory);
    manifest.upstream = origin;
    roster.upstream = origin;
    manifest.graphql = [
      {
        operationName: roster.operationName,
        documentHash: roster.documentHash,
        variablesHash: roster.variablesHash,
        file: `graphql/GetMyBoards/${roster.variablesHash.slice(0, 16)}.json`,
      },
    ];
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(directory, 'graphql/GetMyBoards'), { recursive: true });
    writeFileSync(join(directory, manifest.graphql[0].file), JSON.stringify(roster));
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
    const logs: string[] = [];
    const backend = createScreenshotBackend({
      mode: 'record',
      fixturesDir: directory,
      upstreamUrl: origin,
      frozenNow: manifest.frozenNow,
      flow: 'app-store-cpp',
      log: (line) => logs.push(line),
    });
    try {
      const port = await backend.listen(0, '127.0.0.1');
      const endpoint = `http://127.0.0.1:${port}`;
      const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
      const post = () =>
        fetch(`${endpoint}/graphql`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ operationName: 'SearchClimbsCount', query: count.query, variables: count.variables }),
        });
      await (await post()).json();
      const recorded = readScreenshotFixtureManifest(directory)!;
      expect(recorded.capture!.cpp!.scenes.search.gradeFilter!.expectedCount).toBe(12985);
      const countFile = recorded.capture!.cpp!.scenes.search.gradeFilter!.proof!.file;
      const firstBytes = readFileSync(join(directory, countFile), 'utf8');
      const proofResponse = await fetch(`${endpoint}/__screenshot-backend/cpp-grade-count?locale=en-US`);
      expect(proofResponse.status).toBe(200);
      expect(await proofResponse.json()).toMatchObject({
        selector: cppRecordedCountSelector(12985, 'en-US'),
        proof: { totalCount: 12985 },
      });
      await (await post()).json();
      expect(logs.some((line) => line.includes(' DUP '))).toBe(true);
      const duplicateIndex = logs.findIndex((line) => line.includes(' DUP '));
      expect(
        logs
          .slice(0, duplicateIndex)
          .filter(
            (line) => line.includes('CPP-UPSTREAM') && line.includes('phase=response') && line.includes('status=200'),
          ),
      ).toHaveLength(2);
      totalCount = 12986;
      await (await post()).json();
      expect(logs.some((line) => line.includes('cpp-exact-grade-count-provenance-or-count-changed'))).toBe(true);
      expect(readFileSync(join(directory, countFile), 'utf8')).toBe(firstBytes);
      expect((await fetch(`${endpoint}/__screenshot-backend/cpp-grade-count?locale=en-US`)).status).toBe(409);
    } finally {
      await backend.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});

describe('readiness count belongs to the exact acknowledged scene', () => {
  it('rejects stale/unacknowledged sequences, wrong scene, locale and nonlocal callers before reading the backend', async () => {
    let handler:
      | ((
          request: { url: string; socket: { remoteAddress: string } },
          response: { destroyed: boolean; writeHead: (status: number) => void; end: (body?: string) => void },
        ) => void)
      | undefined;
    const fetchCount = vi.fn(async () => ({
      ok: true,
      json: async () => ({ proof: { totalCount: 12985 }, selector: cppRecordedCountSelector(12985, 'en-US') }),
    }));
    runInNewContext(buildReadinessServerScript(19871), {
      URL,
      AbortSignal,
      setTimeout,
      fetch: fetchCount,
      require: (name: string) =>
        name === 'http'
          ? {
              createServer: (callback: NonNullable<typeof handler>) => {
                handler = callback;
                return { listen: () => {} };
              },
            }
          : {},
    });
    const request = (url: string, remoteAddress = '127.0.0.1') =>
      new Promise<{ status: number; body: string }>((resolve) => {
        let status = 0;
        handler!(
          { url, socket: { remoteAddress } },
          {
            destroyed: false,
            writeHead: (code) => {
              status = code;
            },
            end: (body = '') => resolve({ status, body }),
          },
        );
      });
    await request('/cpp/set?scene=search-grade');
    expect((await request('/cpp/grade-count?sequence=1&locale=en-US')).status).toBe(409);
    await request('/cpp/ack?sequence=1');
    expect((await request('/cpp/grade-count?sequence=2&locale=en-US')).status).toBe(409);
    expect((await request('/cpp/grade-count?sequence=1&locale=it')).status).toBe(409);
    expect((await request('/cpp/grade-count?sequence=1&locale=en-US', '192.0.2.1')).status).toBe(403);
    expect(fetchCount).not.toHaveBeenCalled();
    const actual = await request('/cpp/grade-count?sequence=1&locale=en-US');
    expect(JSON.parse(actual.body)).toMatchObject({ sequence: 1, locale: 'en-US', proof: { totalCount: 12985 } });
    expect(fetchCount).toHaveBeenCalledOnce();
    await request('/cpp/set?scene=search-results');
    await request('/cpp/ack?sequence=2');
    expect((await request('/cpp/grade-count?sequence=2&locale=en-US')).status).toBe(409);
  });
});
