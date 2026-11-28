/// <reference types="node" />
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { BOARD_LAYERS, RESOLVE_BOARD_FOR_UUID } from '../../packages/shared/graphql/src/operations/board-presence';
import { GET_USER_TICKS } from '../../packages/shared/graphql/src/operations/ticks';
import { importMobileSmokeQaFixtures, type ImportSmokeQaOptions } from '../import-mobile-smoke-qa-fixtures';
import { applyFixtureOverlay } from '../lib/screenshot-fixture-overlay';
import { snapshotHash } from '../lib/screenshot-fixture-snapshot';
import {
  canonicalJson,
  emptyManifest,
  graphqlFixtureKey,
  type GraphqlFixtureFile,
  type ScreenshotFixtureManifest,
} from '../lib/screenshot-fixtures';

const USER_ID = 'fbb773f8-5bec-473e-8216-e34ca55b073b';
const BOARD_UUID = 'dcb443be-aaea-4637-8bf8-b20cbe031192';
const UPSTREAM = 'https://ws.boardsesh.com';

function manifest(flow: string): ScreenshotFixtureManifest {
  return emptyManifest({
    recordedAt: '2026-11-22T00:00:00Z',
    frozenNow: '2026-11-22T00:00:01Z',
    upstream: UPSTREAM,
    accountUserId: USER_ID,
    accountEmail: 'test@boardsesh.com',
    flow,
  });
}
function add(files: Map<string, Buffer>, operationName: string, query: string, variables: unknown, response: unknown) {
  const current = JSON.parse(files.get('manifest.json')!.toString()) as ScreenshotFixtureManifest;
  const key = graphqlFixtureKey({ operationName, query, variables }, (text) => snapshotHash(Buffer.from(text)));
  const file = `graphql/${operationName}/${key.variablesHash.slice(0, 16)}.json`;
  const fixture: GraphqlFixtureFile = {
    formatVersion: 1,
    ...key,
    query,
    variables,
    response,
    status: 200,
    recordedAt: '2026-11-28T01:02:03.500Z',
    upstream: UPSTREAM,
  };
  files.set(file, Buffer.from(JSON.stringify(fixture)));
  current.graphql.push({ ...key, file });
  files.set('manifest.json', Buffer.from(JSON.stringify(current)));
  return file;
}
function setup() {
  const base = new Map<string, Buffer>([['manifest.json', Buffer.from(JSON.stringify(manifest('help')))]]);
  add(
    base,
    'ResolveBoardForUuid',
    RESOLVE_BOARD_FOR_UUID,
    { boardUuid: BOARD_UUID },
    { data: { resolveBoardForUuid: { boardId: 4, boardType: 'kilter' } } },
  );
  const baseArchive = gzipSync(
    JSON.stringify({
      version: 1,
      files: Object.fromEntries([...base].map(([path, bytes]) => [path, bytes.toString('base64')])),
    }),
  );
  const recordedFiles = new Map<string, Buffer>([['manifest.json', Buffer.from(JSON.stringify(manifest('smoke')))]]);
  const layerPath = add(
    recordedFiles,
    'BoardLayers',
    BOARD_LAYERS,
    { boardId: 4, boardUuid: BOARD_UUID },
    { data: { boardLayers: null } },
  );
  const tickPath = add(
    recordedFiles,
    'GetUserTicks',
    GET_USER_TICKS,
    { userId: USER_ID, boardType: 'quantum' },
    { data: { userTicks: [] } },
  );
  add(recordedFiles, 'UnrelatedRead', 'query UnrelatedRead { ignored }', {}, { data: { ignored: 'Not imported' } });
  const options: ImportSmokeQaOptions = {
    reference: {
      version: 1,
      url: 'https://fixtures.example.com/base.json.gz',
      sha256: snapshotHash(baseArchive),
      bytes: baseArchive.length,
      files: base.size,
    },
    baseArchive,
    recordedFiles,
  };
  return { base, recordedFiles, layerPath, tickPath, options };
}
function rewrite(files: Map<string, Buffer>, file: string, mutate: (fixture: Record<string, unknown>) => void) {
  const fixture = JSON.parse(files.get(file)!.toString()) as Record<string, unknown>;
  mutate(fixture);
  files.set(file, Buffer.from(JSON.stringify(fixture)));
}

describe('required native QA fixture import', () => {
  it('adds only the two exact genuine reads and preserves every previous response byte', () => {
    const { base, recordedFiles, layerPath, tickPath, options } = setup();
    const result = importMobileSmokeQaFixtures(options);
    const candidate = applyFixtureOverlay(base, options.reference.sha256, result.compressed, result.reference.overlay);
    expect(candidate.size).toBe(base.size + 2);
    for (const [path, bytes] of base) if (path !== 'manifest.json') expect(candidate.get(path)).toEqual(bytes);
    for (const path of [layerPath, tickPath]) expect(candidate.get(path)).toEqual(recordedFiles.get(path));
    const next = JSON.parse(candidate.get('manifest.json')!.toString()) as ScreenshotFixtureManifest;
    expect(next.flow).toBe('help');
    expect(next.recordedAt).toBe('2026-11-28T01:02:03.500Z');
    expect(Date.parse(next.frozenNow)).toBeGreaterThan(Date.parse(next.recordedAt));
    expect(result.proof.unchangedRecordedFiles).toBe(base.size - 1);
    expect(result.proof.addedGraphqlFiles.map((entry) => entry.operationName)).toEqual(['BoardLayers', 'GetUserTicks']);
    expect([...candidate.values()].some((bytes) => bytes.includes('Not imported'))).toBe(false);
  });

  it.each(['accountUserId', 'accountEmail', 'upstream', 'flow'])('rejects a mismatched recording %s', (field) => {
    const { recordedFiles, options } = setup();
    rewrite(recordedFiles, 'manifest.json', (current) => {
      current[field] = 'different';
    });
    expect(() => importMobileSmokeQaFixtures(options)).toThrow();
  });

  it.each(['query', 'variables', 'documentHash', 'variablesHash', 'status', 'upstream', 'recordedAt', 'response'])(
    'rejects changed %s rather than manufacturing layer data',
    (field) => {
      const { recordedFiles, layerPath, options } = setup();
      rewrite(recordedFiles, layerPath, (fixture) => {
        fixture[field] = field === 'response' ? { data: { boardLayers: { boardId: 4, layers: [] } } } : 'changed';
      });
      expect(() => importMobileSmokeQaFixtures(options)).toThrow();
    },
  );

  it('requires a genuine empty Quantum tick response rather than discarding new history', () => {
    const { recordedFiles, tickPath, options } = setup();
    rewrite(recordedFiles, tickPath, (fixture) => {
      fixture.response = { data: { userTicks: [{ climbUuid: 'new-tick' }] } };
    });
    expect(() => importMobileSmokeQaFixtures(options)).toThrow('Unexpected GetUserTicks');
  });

  it('rejects missing exact variables instead of using another wall recording', () => {
    const { recordedFiles, layerPath, options } = setup();
    const source = JSON.parse(recordedFiles.get('manifest.json')!.toString()) as ScreenshotFixtureManifest;
    source.graphql = source.graphql.filter((entry) => entry.file !== layerPath);
    recordedFiles.set('manifest.json', Buffer.from(JSON.stringify(source)));
    expect(() => importMobileSmokeQaFixtures(options)).toThrow('Missing exact BoardLayers');
  });

  it('carries unrelated earlier overlay recordings forward byte-for-byte', () => {
    const { base, options } = setup();
    const previous = new Map(base);
    add(previous, 'ExistingOverlayRead', 'query ExistingOverlayRead { ok }', {}, { data: { ok: true } });
    const overlayBytes = gzipSync(
      JSON.stringify({
        version: 1,
        baseSha256: options.reference.sha256,
        files: Object.fromEntries(
          [...previous]
            .filter(([path]) => path === 'manifest.json' || !base.has(path))
            .map(([path, bytes]) => [path, bytes.toString('base64')]),
        ),
      }),
    );
    const sha256 = snapshotHash(overlayBytes);
    const result = importMobileSmokeQaFixtures({
      ...options,
      reference: {
        ...options.reference,
        overlay: {
          path: `app-stores/screenshot-fixture-overlays/${sha256}.json.gz`,
          sha256,
          bytes: overlayBytes.length,
          files: previous.size,
        },
      },
      overlayBytes,
    });
    const candidate = applyFixtureOverlay(base, options.reference.sha256, result.compressed, result.reference.overlay);
    for (const [path, bytes] of previous) if (path !== 'manifest.json') expect(candidate.get(path)).toEqual(bytes);
    expect(candidate.size).toBe(previous.size + 2);
    expect(result.proof.previousOverlaySha256).toBe(sha256);
  });

  it('preserves an existing overlay while refusing to replace an imported target', () => {
    const { base, options } = setup();
    const first = importMobileSmokeQaFixtures(options);
    const nextOptions = { ...options, reference: first.reference, overlayBytes: first.compressed };
    expect(() => importMobileSmokeQaFixtures(nextOptions)).toThrow('already recorded');
    const candidate = applyFixtureOverlay(base, options.reference.sha256, first.compressed, first.reference.overlay);
    expect(canonicalJson(JSON.parse(candidate.get('manifest.json')!.toString()))).toContain('BoardLayers');
  });
});
