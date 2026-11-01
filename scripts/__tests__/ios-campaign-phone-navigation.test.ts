/// <reference types="node" />

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';
import { SEARCH_CLIMBS } from '../../packages/mobile/src/lib/graphql/operations';
import { resolveScreenshotCppBoard } from '../../packages/mobile/src/lib/screenshot-cpp-board-identity';
import { DEFAULT_CLIMB_FILTER_STATE, toClimbSearchInput } from '../../packages/shared/climb-filters/src/filter-state';
import {
  buildScreenshotEnv,
  buildIosDuoInnerShots,
  compileIosCampaignDuoNavigation,
  compileIosCampaignPhoneNavigation,
  parseArgs,
  readIosCampaignPhoneBoards,
  renderedFlowFileForIosDevice,
  resolveIosScreenshotDevices,
  type IosCampaignPhoneBoard,
} from '../mobile-screenshots';
import { emptyManifest, graphqlFixtureKey, type GraphqlFixtureFile } from '../lib/screenshot-fixtures';
import { IOS_CAMPAIGN_CAPTURE_NAMES } from '../lib/screenshot-presentation';

const boardTypes = ['kilter', 'tension', 'moonboard', 'woods', 'decoy', 'grasshopper', 'spray'];
const boards = boardTypes.map((boardType, index) => ({
  selector: `Recorded ${boardType}`,
  board: {
    name: `Recorded ${boardType}`,
    uuid: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    boardType,
    layoutId: index + 1,
    sizeId: index + 1,
    setIds: '2,1',
    angle: 40,
  },
  climb: {
    uuid: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    name: `First real ${boardType}`,
    frames: 'p1r12',
    angle: 40,
  },
})) satisfies IosCampaignPhoneBoard[];
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('default Duo command compilation', () => {
  it('registers and executes exactly the inner-shot commands with independent scenes and verified second-board seed', () => {
    const options = {
      ...parseArgs(['--flow', 'app-store-campaign', '--devices', 'duo']),
      iosCampaignPhoneBoards: boards,
      iosCampaignPrimaryCapture: { board: boards[0].board, climb: boards[0].climb, paintedId: 'real-primary-painted' },
    };
    const source = readFileSync('packages/mobile/.maestro/app-store-duo-inner.yaml', 'utf8');
    const compiled = compileIosCampaignDuoNavigation(source, boards);
    const env = buildScreenshotEnv(options, { NODE_ENV: 'test' }, 'en-US', '2026-10-13T01:00:01Z', 8090);
    const registry = JSON.parse(env.EXPO_PUBLIC_SCREENSHOT_PRIMARY_BOARD_COMMANDS!) as typeof compiled.commands;
    const scenes = Object.keys(compiled.commands);
    expect(scenes).toEqual(['campaign-duo-climbs-0', 'campaign-duo-climbs-1', 'campaign-duo-climbs-2']);
    expect(Object.fromEntries(scenes.map((scene) => [scene, registry[scene]]))).toEqual(compiled.commands);
    expect(Object.keys(registry).filter((scene) => scene.startsWith('campaign-duo-climbs-'))).toEqual(scenes);
    expect(registry['campaign-phone-climbs-0']).toBeDefined();
    expect(registry['hero-1']).toBeDefined();
    expect(env.EXPO_PUBLIC_SCREENSHOT_CPP_URL).toBeUndefined();
    expect(env.EXPO_PUBLIC_SCREENSHOT_CPP_COMMANDS).toBeUndefined();

    const [device] = resolveIosScreenshotDevices(options.devices);
    const shots = buildIosDuoInnerShots(options, device);
    expect(shots.map(({ name, relaunch }) => ({ name, relaunch }))).toEqual([
      { name: '00-board-view', relaunch: false },
      { name: '03-home', relaunch: false },
      { name: '04-playlist-detail', relaunch: false },
      { name: '02-climbs', relaunch: false },
      { name: '01-board-view-2', relaunch: true },
    ]);
    const flow = shots.map((shot) => shot.flow).join('\n');
    expect(flow).not.toMatch(/openLink: com\.boardsesh\.app:\/\/climbs/);
    expect(flow).toContain('- openLink: com.boardsesh.app://home');
    expect(flow).toContain('- openLink: com.boardsesh.app://discover/smart/RECOMMENDED_CROWD_FAVORITES');
    const gates = (text: string) => text.split('\n').filter((line) => /id:|timeout:/.test(line));
    expect(gates(flow)).toEqual(gates(source));

    type NavigationCommand = { evalScript?: string; assertTrue?: string; retry?: { commands: NavigationCommand[] } };
    const output: Record<string, unknown> = {};
    const routes: string[] = [];
    let sequence = 0;
    let acknowledged = 0;
    const execute = (commands: NavigationCommand[], commit = true) => {
      const scope = {
        output,
        SCREENSHOT_PRIMARY_BOARD_URL: 'http://localhost:19870/cpp',
        http: {
          get: (rawUrl: string) => {
            const url = new URL(rawUrl);
            const scene = url.searchParams.get('scene');
            if (url.pathname === '/cpp/set') {
              if (!scene || !registry[scene]) throw new Error('Unregistered capture command');
              sequence++;
              if (commit) {
                routes.push(registry[scene].route);
                acknowledged = sequence;
              }
            }
            return { body: JSON.stringify({ sequence, acknowledged }) };
          },
        },
      };
      for (const command of commands) {
        if (command.evalScript) runInNewContext(command.evalScript.slice(2, -1), scope);
        if (command.retry) execute(command.retry.commands, commit);
        if (command.assertTrue && !runInNewContext(command.assertTrue.slice(2, -1), scope))
          throw new Error('Board navigation has not acknowledged');
      }
    };
    for (const shot of shots) execute(parseAllDocuments(shot.flow)[1].toJS() as NavigationCommand[]);
    expect(routes).toEqual(scenes.map((scene) => registry[scene].route));
    const secondBoard = registry[scenes[2]];
    expect(secondBoard.identity.uuid).toBe(boards[1].board.uuid);
    const secondRoute = new URL(routes[2], 'http://localhost');
    expect(secondRoute.searchParams.get('screenshotClimbId')).toBe(boards[1].climb.uuid);
    expect(secondRoute.searchParams.get('screenshotCppScene')).toBe(scenes[2]);
    expect(secondRoute.searchParams.get('screenshotBoardIndex')).toBe('1');
    expect(secondRoute.searchParams.get('screenshotOpenFirst')).toBe('1');
    expect(() => execute(parseAllDocuments(shots[4].flow)[1].toJS() as NavigationCommand[], false)).toThrow(
      'Board navigation has not acknowledged',
    );
  });

  it('keeps legacy Duo links outside campaign mode and refuses unverified campaign boards', () => {
    const options = parseArgs(['--flow', 'app-store', '--fixtures', 'off', '--devices', 'duo']);
    const [device] = resolveIosScreenshotDevices(options.devices);
    expect(buildIosDuoInnerShots(options, device)[4].flow).toContain(
      '- openLink: com.boardsesh.app://climbs?screenshotOpenFirst=1&screenshotBoardIndex=1',
    );
    expect(() => buildIosDuoInnerShots({ ...options, flow: 'app-store-campaign' }, device)).toThrow(
      'Duo campaign requires verified board navigation',
    );
    expect(() => compileIosCampaignDuoNavigation('- openLink: com.boardsesh.app://climbs', boards.slice(1))).toThrow(
      'seven verified boards',
    );
  });
});
function directory(): string {
  const result = mkdtempSync(join(tmpdir(), 'campaign-phone-navigation-'));
  directories.push(result);
  return result;
}

function recordedSeeds() {
  const root = directory();
  const manifest = emptyManifest({
    recordedAt: '2026-10-13T01:00:00Z',
    frozenNow: '2026-10-13T01:00:01Z',
    upstream: 'https://ws.boardsesh.com',
    accountEmail: 'shots@boardsesh.com',
    accountUserId: '11111111-2222-4333-8444-555555555555',
    flow: 'app-store-campaign',
  });
  manifest.capture = {
    sharedSessionId: '00000000-0000-4000-8000-000000000101',
    boards: boards.map(({ selector }) => selector),
  };
  for (const { board, climb } of boards) {
    const variables = {
      input: toClimbSearchInput(
        DEFAULT_CLIMB_FILTER_STATE,
        {
          boardName: board.boardType,
          layoutId: board.layoutId,
          sizeId: board.sizeId,
          setIds: '1,2',
          angle: board.angle,
        },
        { page: 0, pageSize: 6 },
      ),
    };
    const request = { operationName: 'SearchClimbs', query: SEARCH_CLIMBS, variables };
    const key = graphqlFixtureKey(request, (text) => createHash('sha256').update(text).digest('hex'));
    const file = `graphql/SearchClimbs/${key.variablesHash.slice(0, 16)}.json`;
    const fixture: GraphqlFixtureFile = {
      formatVersion: 1,
      ...request,
      ...key,
      status: 200,
      recordedAt: manifest.recordedAt,
      upstream: manifest.upstream,
      response: {
        data: {
          searchClimbs: {
            climbs: [
              { ...climb, boardType: board.boardType, layoutId: board.layoutId, compatibleSizeIds: [board.sizeId] },
            ],
            hasMore: true,
          },
        },
      },
    };
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), JSON.stringify(fixture));
    manifest.graphql.push({ ...key, file });
  }
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
  return { root, manifest };
}

function readCapture(root: string, roster = boards.map(({ board }) => board)) {
  return readIosCampaignPhoneBoards(
    root,
    boards.map(({ selector }) => selector),
    roster,
  );
}

describe('seven recorded default phone campaign identities', () => {
  it('proves all seven exact boards and hero rows despite set ordering and duplicate identical roster answers', () => {
    const { root } = recordedSeeds();
    expect(readCapture(root, [...boards.map(({ board }) => board), boards[0].board])).toEqual(boards);
  });

  it('turns accepted selector aliases into exact recorded names for the native command resolver', () => {
    const { root } = recordedSeeds();
    const roster = boards.map(({ board }, index) => ({ ...board, layoutName: `Layout ${index}` }));
    const selectors = boards.map(({ selector }, index) => (index === 2 ? 'layout 2' : selector.toUpperCase()));
    const captures = readIosCampaignPhoneBoards(root, selectors, roster);
    const compiled = compileIosCampaignPhoneNavigation(
      '- openLink: com.boardsesh.app://climbs?screenshotOpenFirst=1&screenshotBoardIndex=2',
      captures,
    );
    const command = compiled.commands['campaign-phone-climbs-0'];
    expect(command.selector).toBe(boards[2].board.name);
    expect(resolveScreenshotCppBoard(roster, command.selector, command.identity)?.uuid).toBe(boards[2].board.uuid);
  });

  it.each(['missing-seed', 'stale-query', 'invalid-hash', 'wrong-climb-board', 'wrong-climb-size', 'filtered-seed'])(
    'rejects %s before native capture',
    (failure) => {
      const { root, manifest } = recordedSeeds();
      const entry = manifest.graphql[2];
      const fixture = JSON.parse(readFileSync(join(root, entry.file), 'utf8')) as GraphqlFixtureFile;
      if (failure === 'missing-seed') manifest.graphql.splice(2, 1);
      if (failure === 'stale-query') fixture.query += ' # stale selection';
      if (failure === 'invalid-hash') fixture.variablesHash = '0'.repeat(64);
      if (failure === 'filtered-seed') (fixture.variables as { input: Record<string, unknown> }).input.minGrade = 20;
      if (failure === 'wrong-climb-board' || failure === 'wrong-climb-size') {
        const response = fixture.response as { data: { searchClimbs: { climbs: Array<Record<string, unknown>> } } };
        if (failure === 'wrong-climb-board') response.data.searchClimbs.climbs[0].boardType = 'kilter';
        else response.data.searchClimbs.climbs[0].compatibleSizeIds = [999];
      }
      writeFileSync(join(root, entry.file), JSON.stringify(fixture));
      writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
      expect(() => readCapture(root)).toThrow(/seed/);
    },
  );

  it('rejects missing, ambiguous or malformed board identities rather than guessing by position', () => {
    const { root } = recordedSeeds();
    expect(() =>
      readCapture(
        root,
        boards.slice(1).map(({ board }) => board),
      ),
    ).toThrow(/identity/);
    expect(() =>
      readCapture(root, [
        ...boards.map(({ board }) => board),
        { ...boards[2].board, uuid: '11111111-2222-4333-8444-555555555555' },
      ]),
    ).toThrow(/ambiguous/);
    expect(() =>
      readCapture(
        root,
        boards.map(({ board }, index) => (index === 2 ? { ...board, setIds: 'not sets' } : board)),
      ),
    ).toThrow(/identity/);
  });
});

describe('default phone command compilation', () => {
  it('gives every occurrence its own scene while preserving other params and avoiding auto-open on previews or restores', () => {
    const source = [
      '- openLink: com.boardsesh.app://climbs?screenshotOpenFirst=1&screenshotBoardIndex=2',
      '- openLink: com.boardsesh.app://climbs?screenshotOpenFirst=1&screenshotBoardIndex=2',
      '- openLink: com.boardsesh.app://climbs?screenshotOpenPreview=1&custom=keep%20me',
      '- openLink: com.boardsesh.app://climbs',
      '- openLink: com.boardsesh.app://home',
      '- extendedWaitUntil:\n    visible:\n      id: play-drawer-board-overlay\n    timeout: 90000',
      "- extendedWaitUntil:\n    visible:\n      id: '^cpp-climb-painted-.+$'\n    timeout: 90000",
    ].join('\n');
    const result = compileIosCampaignPhoneNavigation(source, boards);
    expect(result.source).not.toMatch(/openLink: com\.boardsesh\.app:\/\/climbs/);
    expect(result.source).toContain('- openLink: com.boardsesh.app://home');
    expect(result.source).toContain("id: '^cpp-climb-painted-.+$'");
    expect(result.source).toContain('id: play-drawer-board-overlay');
    const commands = Object.entries(result.commands);
    expect(commands.map(([scene]) => scene)).toEqual([
      'campaign-phone-climbs-0',
      'campaign-phone-climbs-1',
      'campaign-phone-climbs-2',
      'campaign-phone-climbs-3',
    ]);
    for (const [scene, command] of commands)
      expect(new URL(command.route, 'http://localhost').searchParams.get('screenshotCppScene')).toBe(scene);
    for (const [, command] of commands.slice(0, 2)) {
      expect(command.identity.uuid).toBe(boards[2].board.uuid);
      expect(new URL(command.route, 'http://localhost').searchParams.get('screenshotClimbId')).toBe(
        boards[2].climb.uuid,
      );
    }
    expect(commands[0][1].route).not.toBe(commands[1][1].route);
    for (const [, command] of commands.slice(2))
      expect(new URL(command.route, 'http://localhost').searchParams.has('screenshotClimbId')).toBe(false);
    expect(new URL(commands[2][1].route, 'http://localhost').searchParams.get('custom')).toBe('keep me');
    expect(result.source.match(/\/set\?scene=/g)).toHaveLength(4);
    expect(result.source.match(/\/status\?waitFor=/g)).toHaveLength(4);
    const parsed = parseAllDocuments(result.source);
    for (const document of parsed) expect(document.errors).toEqual([]);
  });

  it.each(['7', '-1', '2oops', '', '1&screenshotBoardIndex=2'])('rejects invalid board index %s', (index) =>
    expect(() =>
      compileIosCampaignPhoneNavigation(`- openLink: com.boardsesh.app://climbs?screenshotBoardIndex=${index}`, boards),
    ).toThrow(/invalid board index/),
  );

  it('rejects uncompiled Climbs routes and excess command occurrences', () => {
    expect(() => compileIosCampaignPhoneNavigation('- openLink: com.boardsesh.app://climbs/create', boards)).toThrow(
      /Uncompiled/,
    );
    expect(() =>
      compileIosCampaignPhoneNavigation(
        Array.from({ length: 33 }, () => '- openLink: com.boardsesh.app://climbs').join('\n'),
        boards,
      ),
    ).toThrow();
  });

  it('registers exactly the compiled phone commands in Metro with CPP mapping unset, preserving all captures and native gates', () => {
    const captureDir = directory();
    const options = {
      ...parseArgs(['--flow', 'app-store-campaign', '--devices', 'phones']),
      iosCampaignPhoneBoards: boards,
      iosCampaignPrimaryCapture: { board: boards[0].board, climb: boards[0].climb, paintedId: 'real-primary-painted' },
    };
    const env = buildScreenshotEnv(
      options,
      {
        NODE_ENV: 'test',
        EXPO_PUBLIC_SCREENSHOT_CPP_URL: 'stale',
        EXPO_PUBLIC_SCREENSHOT_CPP_COMMANDS: 'stale',
      },
      'it',
      '2026-10-13T01:00:01Z',
      8090,
    );
    const registry = JSON.parse(env.EXPO_PUBLIC_SCREENSHOT_PRIMARY_BOARD_COMMANDS!) as Record<
      string,
      { route: string }
    >;
    expect(env.EXPO_PUBLIC_SCREENSHOT_CPP_URL).toBeUndefined();
    expect(env.EXPO_PUBLIC_SCREENSHOT_CPP_COMMANDS).toBeUndefined();
    for (const screenshotDevice of resolveIosScreenshotDevices(options.devices)) {
      const file = renderedFlowFileForIosDevice(options, screenshotDevice, captureDir, 'it');
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/^\s*- openLink:.*\/\/climbs/m);
      const scenes = [...source.matchAll(/\/set\?scene=(campaign-phone-climbs-\d+)/g)].map((match) => match[1]);
      expect(scenes).toHaveLength(11);
      expect(new Set(scenes).size).toBe(11);
      expect(Object.keys(registry).filter((scene) => scene.startsWith('campaign-phone-climbs-'))).toEqual(scenes);
      const raw = readFileSync('packages/mobile/.maestro/app-store-campaign.yaml', 'utf8').replace(
        '- runFlow: app-store.yaml',
        () => readFileSync('packages/mobile/.maestro/app-store.yaml', 'utf8').split('\n---\n')[1],
      );
      expect([...source.matchAll(/^- takeScreenshot: ([^\n]+)/gm)].map((match) => `${match[1]}.png`).sort()).toEqual(
        [...IOS_CAMPAIGN_CAPTURE_NAMES].sort(),
      );
      const nativeGates = (text: string) =>
        text.split('\n').filter((line) => /id:|timeout:|takeScreenshot:/.test(line));
      expect(nativeGates(source)).toEqual(nativeGates(raw));
    }
    const [ipad] = resolveIosScreenshotDevices(['iPad Pro 13-inch (M5)']);
    const ipadSource = readFileSync(renderedFlowFileForIosDevice(options, ipad, captureDir), 'utf8');
    expect(ipadSource).not.toContain('campaign-phone-climbs-');
    const legacy = parseArgs(['--flow', 'app-store', '--fixtures', 'off', '--devices', 'phones']);
    const [phone] = resolveIosScreenshotDevices(legacy.devices);
    expect(readFileSync(renderedFlowFileForIosDevice(legacy, phone, captureDir), 'utf8')).toContain(
      'openLink: com.boardsesh.app://climbs?screenshotOpenFirst=1',
    );
  });
});
