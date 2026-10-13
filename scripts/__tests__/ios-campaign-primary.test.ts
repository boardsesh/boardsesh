import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readIosCampaignPrimaryCapture } from '../lib/ios-campaign-primary';
import {
  assertIosCampaignCaptureReady,
  assertIosRegularIpadCaptureFlow,
  buildIosCampaignMaestroEnv,
  buildScreenshotEnv,
  parseArgs,
  resolveIosScreenshotDevices,
} from '../mobile-screenshots';
import { parseScreenshotBoardSelectors } from '../../packages/mobile/src/lib/screenshot-board-matching';
import { SEARCH_CLIMBS } from '../../packages/mobile/src/lib/graphql/operations';
import { createHash } from 'node:crypto';
import { graphqlFixtureKey } from '../lib/screenshot-fixtures';

const recordedManifest = vi.hoisted(() => ({
  graphql: [{ operationName: 'SearchClimbs', file: 'seed.json', documentHash: '', variablesHash: '' }],
}));
vi.mock('../lib/screenshot-backend', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readScreenshotFixtureManifest: () => recordedManifest,
}));
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const board = {
  name: "Marco's Board",
  layoutName: 'Kilter Board Homewall',
  uuid: 'dcb443be-aaea-4637-8bf8-b20cbe031192',
  boardType: 'kilter',
  layoutId: 8,
  sizeId: 25,
  setIds: '26,27,28,29',
  angle: 35,
};
const climb = {
  uuid: 'A6E04278AE294E03AD9DD2A8E0CDE31F',
  name: 'Lightest Pair of Shorts',
  frames: 'p1r12',
  boardType: 'kilter',
  layoutId: 8,
  angle: 35,
  compatibleSizeIds: [25],
};
const input = {
  boardName: 'kilter',
  layoutId: 8,
  sizeId: 25,
  setIds: '29,28,27,26',
  angle: 35,
  page: 0,
  pageSize: 6,
  sortBy: 'ascents',
  sortOrder: 'desc',
  boulders: true,
};
function fixture(query = input, rows = [climb]): string {
  const directory = mkdtempSync(join(tmpdir(), 'regular-primary-'));
  directories.push(directory);
  const request = { operationName: 'SearchClimbs', query: SEARCH_CLIMBS, variables: { input: query } };
  const key = graphqlFixtureKey(request, (text) => createHash('sha256').update(text).digest('hex'));
  Object.assign(recordedManifest.graphql[0], key);
  writeFileSync(
    join(directory, 'seed.json'),
    JSON.stringify({ ...request, ...key, status: 200, response: { data: { searchClimbs: { climbs: rows } } } }),
  );
  return directory;
}

describe('regular primary capture identity', () => {
  it('shares native selector tiers and filtered slot order with campaign preflight', () => {
    const otherTypes = ['tension', 'moonboard', 'woods', 'decoy', 'grasshopper', 'spray'];
    const otherBoards = otherTypes.map((boardType) => ({ name: `Actual ${boardType}`, boardType }));
    const capture = { sharedSessionId: 'crew', boards: [board.name, ...otherBoards.map((board) => board.name)] };
    const options = parseArgs(['--flow', 'app-store-campaign']);
    for (const primarySelector of ['  marcos BOARD ', 'Kilter Board Homewall', 'Homewall']) {
      const rawSelectors = ` | ${primarySelector} || ${otherBoards.map((board) => board.name).join(' | ')} | `;
      const broaderName =
        primarySelector === 'Homewall' ? [] : [{ name: 'Kilter Board Homewall in the shed', boardType: 'tension' }];
      expect(() =>
        assertIosCampaignCaptureReady({ ...options, boards: rawSelectors }, capture, [
          ...broaderName,
          board,
          ...otherBoards,
        ]),
      ).not.toThrow();
      const primary = readIosCampaignPrimaryCapture(fixture(), parseScreenshotBoardSelectors(rawSelectors)[0], [board]);
      expect(primary.board.uuid).toBe(board.uuid);
    }
    const emptyPrimary = ['!!!', ...otherBoards.map((board) => board.name)].join('|');
    expect(() =>
      assertIosCampaignCaptureReady({ ...options, boards: emptyPrimary }, capture, [board, ...otherBoards]),
    ).toThrow(/no recorded board/);
    const wrongExactType = { ...board, name: 'Kilter Board Homewall', boardType: 'tension' };
    expect(() =>
      assertIosCampaignCaptureReady(
        { ...options, boards: ['Kilter Board Homewall', ...otherBoards.map((board) => board.name)].join('|') },
        capture,
        [board, wrongExactType, ...otherBoards],
      ),
    ).toThrow(/must resolve to kilter/);
  });
  it.each(['  marco’S  BOARD  ', 'MarcosBoard', 'marco', '  kilter Board HOMEWALL ', 'Kilter Board'])(
    'accepts the native primary selector form %s',
    (selector) => {
      expect(readIosCampaignPrimaryCapture(fixture(), selector, [board]).board.uuid).toBe(board.uuid);
    },
  );
  it('ignores lower matching tiers while validating every identity in the winning tier', () => {
    const broaderName = { ...board, uuid: 'invalid', name: "Marco's Board in the shed", boardType: 'tension' };
    expect(readIosCampaignPrimaryCapture(fixture(), "Marco's Board", [broaderName, board]).board.uuid).toBe(board.uuid);
    const broaderLayoutName = {
      ...broaderName,
      name: 'Kilter Board Homewall in the shed',
      layoutName: 'Kilter Board Homewall in the shed',
    };
    expect(
      readIosCampaignPrimaryCapture(fixture(), 'Kilter Board Homewall', [broaderLayoutName, board]).board.uuid,
    ).toBe(board.uuid);
    const broaderLayout = { ...broaderName, name: 'Unrelated', layoutName: 'A Marco wall' };
    expect(readIosCampaignPrimaryCapture(fixture(), 'Marco', [broaderLayout, board]).board.uuid).toBe(board.uuid);
    const invalidExactLayout = { ...broaderLayout, layoutName: 'Marco' };
    expect(() => readIosCampaignPrimaryCapture(fixture(), 'Marco', [board, invalidExactLayout])).toThrow(/genuine/);
  });
  it.each(['Marcos Board', 'Kilter Board Homewall', 'Marco', 'Homewall'])(
    'rejects distinct identities selected in the same winning tier: %s',
    (selector) => {
      const another = { ...board, name: 'Marco’s Board', uuid: '11111111-1111-4111-8111-111111111111' };
      expect(() => readIosCampaignPrimaryCapture(fixture(), selector, [board, another])).toThrow(/ambiguous/);
    },
  );
  it.each(['', '   ', '!!!', 'Missing layout'])('rejects selectors without native candidates: %s', (selector) => {
    expect(() => readIosCampaignPrimaryCapture(fixture(), selector, [board])).toThrow(/genuine/);
  });
  it('fails legacy iPad capture before building, retaining campaign, CPP and phone paths', () => {
    const ipads = resolveIosScreenshotDevices(parseArgs(['--devices', 'ipads']).devices);
    for (const fixtures of ['off', 'replay'] as const)
      expect(() =>
        assertIosRegularIpadCaptureFlow(parseArgs(['--flow', 'app-store', '--fixtures', fixtures]), ipads),
      ).toThrow(/app-store-campaign --fixtures replay/);
    expect(() => assertIosRegularIpadCaptureFlow(parseArgs(['--flow', 'app-store-campaign']), ipads)).not.toThrow();
    expect(() => assertIosRegularIpadCaptureFlow(parseArgs(['--cpp', 'kilter']), ipads)).not.toThrow();
    expect(() =>
      assertIosRegularIpadCaptureFlow(
        parseArgs(['--flow', 'app-store', '--fixtures', 'off']),
        resolveIosScreenshotDevices(parseArgs(['--devices', 'phones']).devices),
      ),
    ).not.toThrow();
    const orchestrator = readFileSync('scripts/mobile-screenshots.ts', 'utf8').split('function runIos(options:')[1];
    expect(orchestrator.indexOf('assertIosRegularIpadCaptureFlow(options, screenshotDevices)')).toBeLessThan(
      orchestrator.indexOf('resolveAppPath(options)'),
    );
    expect(orchestrator.indexOf('assertIosRegularIpadCaptureFlow(options, screenshotDevices)')).toBeLessThan(
      orchestrator.indexOf('startReadinessServer('),
    );
  });
  it.each([
    { status: 500 },
    { documentHash: 'wrong-document' },
    { variablesHash: 'wrong-variables' },
    { response: { errors: [{ message: 'unavailable' }], data: { searchClimbs: { climbs: [climb] } } } },
  ])('rejects unsuccessful or corrupted recorded seed evidence: %j', (change) => {
    const directory = fixture();
    const filename = join(directory, 'seed.json');
    const response = JSON.parse(readFileSync(filename, 'utf8')) as Record<string, unknown>;
    writeFileSync(filename, JSON.stringify({ ...response, ...change }));
    expect(() => readIosCampaignPrimaryCapture(directory, board.name, [board])).toThrow(/provenance/);
  });
  it('rejects an unrelated GraphQL document and an invalid genuine climb identifier', () => {
    const directory = fixture();
    const filename = join(directory, 'seed.json');
    const response = JSON.parse(readFileSync(filename, 'utf8')) as Record<string, unknown>;
    writeFileSync(filename, JSON.stringify({ ...response, query: 'query SearchClimbs { otherField }' }));
    expect(() => readIosCampaignPrimaryCapture(directory, board.name, [board])).toThrow(/unambiguous/);
    expect(() =>
      readIosCampaignPrimaryCapture(fixture(input, [{ ...climb, uuid: 'invalid' }]), board.name, [board]),
    ).toThrow(/seed/);
  });
  it('deduplicates identical real roster answers, preserving the recorded climb and geometry', () => {
    const primary = readIosCampaignPrimaryCapture(fixture(), board.name, [board, { ...board, setIds: '29,28,27,26' }]);
    expect(primary.climb).toEqual({ uuid: climb.uuid, name: climb.name, frames: climb.frames, angle: 35 });
    expect(primary.paintedId).toBe(`store-kiosk-painted-${board.uuid}-${climb.uuid}-kilter-8-25-26-27-28-29-35`);
  });
  it.each([{ uuid: '11111111-1111-4111-8111-111111111111' }, { sizeId: 19 }, { angle: 40 }, { setIds: '26' }])(
    'rejects conflicting recorded primary identities: %j',
    (change) => {
      expect(() => readIosCampaignPrimaryCapture(fixture(), board.name, [board, { ...board, ...change }])).toThrow(
        /ambiguous/,
      );
    },
  );
  it('rejects missing names, malformed geometry, empty artwork and a wrong first seed', () => {
    expect(() => readIosCampaignPrimaryCapture(fixture(), 'Unknown', [board])).toThrow(/genuine/);
    expect(() => readIosCampaignPrimaryCapture(fixture(), board.name, [{ ...board, setIds: 'invalid' }])).toThrow(
      /genuine/,
    );
    expect(() =>
      readIosCampaignPrimaryCapture(fixture(input, [{ ...climb, frames: '' }]), board.name, [board]),
    ).toThrow(/seed/);
    expect(() =>
      readIosCampaignPrimaryCapture(fixture(input, [{ ...climb, name: 'Wrong first climb' }, climb]), board.name, [
        board,
      ]),
    ).toThrow(/seed/);
  });
  it.each([
    { boardName: 'tension' },
    { sizeId: 19 },
    { setIds: '26' },
    { angle: 40 },
    { page: 1 },
    { pageSize: 30 },
    { sortBy: 'name' },
    { sortOrder: 'asc' },
    { boulders: false },
    { minGrade: 14 },
  ])('rejects a seed from another query: %j', (change) => {
    expect(() => readIosCampaignPrimaryCapture(fixture({ ...input, ...change }), board.name, [board])).toThrow(
      /unambiguous/,
    );
  });
  it.each([{ uuid: '' }, { boardType: 'tension' }, { layoutId: 9 }, { angle: 40 }, { compatibleSizeIds: [19] }])(
    'rejects an incompatible real seed row: %j',
    (change) => {
      expect(() =>
        readIosCampaignPrimaryCapture(fixture(input, [{ ...climb, ...change }]), board.name, [board]),
      ).toThrow(/seed/);
    },
  );
  it('uses the separate regular command endpoint while retaining seven board slots', () => {
    const primary = readIosCampaignPrimaryCapture(fixture(), board.name, [board]);
    const options = {
      ...parseArgs(['--flow', 'app-store-campaign']),
      iosCampaignPrimaryCapture: primary,
      boards: 'a|b|c|d|e|f|g',
    };
    const env = buildScreenshotEnv(
      options,
      {
        EXPO_PUBLIC_SCREENSHOT_CPP_URL: 'stale',
        EXPO_PUBLIC_SCREENSHOT_CPP_COMMANDS: 'stale',
      } as NodeJS.ProcessEnv,
      'en-US',
      '2026-10-13T12:00:00.000Z',
      19869,
    );
    expect(env.EXPO_PUBLIC_SCREENSHOT_CPP_URL).toBeUndefined();
    expect(env.EXPO_PUBLIC_SCREENSHOT_CPP_COMMANDS).toBeUndefined();
    expect(env.EXPO_PUBLIC_SCREENSHOT_BOARDS).toBe(options.boards);
    expect(JSON.parse(env.EXPO_PUBLIC_SCREENSHOT_PRIMARY_BOARD_COMMANDS!)['hero-1']).toEqual({
      selector: board.name,
      identity: { uuid: board.uuid, boardType: 'kilter', layoutId: 8, sizeId: 25, setIds: [26, 27, 28, 29], angle: 35 },
      route: '/climbs?screenshotBoardIndex=0',
    });
    for (const locale of ['en-US', 'es', 'fr', 'de'] as const) {
      const variables = buildIosCampaignMaestroEnv(locale, undefined, primary);
      expect(variables).toContain(`SCREENSHOT_PRIMARY_WALL_PAINTED_ID=^${primary.paintedId}$`);
      expect(variables).toContain(`SCREENSHOT_PRIMARY_CLIMB_TITLE=${climb.name}`);
      const row = variables
        .find((variable) => variable.startsWith('SCREENSHOT_PRIMARY_CLIMB_ROW='))!
        .split('=')
        .slice(1)
        .join('=');
      expect(new RegExp(row).test('Lightest Pair of Shorts, V4, 35°')).toBe(true);
      expect(new RegExp(row).test('Other Climb, V4, 35°')).toBe(false);
    }
  });
});
