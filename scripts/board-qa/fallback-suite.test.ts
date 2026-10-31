import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Backend, type Snapshot } from './backend';
import { EXAMPLE_CONFIG, type Board, type Role } from './config';
import { IosDriver, readFlow, type Driver } from './drivers';
import * as driverTools from './drivers';
import { Fixture, type FixtureStatus } from './fixture';
import { Evidence, QaFailure } from './evidence';
import * as evidenceTools from './evidence';
import { SimulatorPeerSuite } from './fallback-suite';
import {
  bindSimulatorMetro,
  fallbackCoverage,
  requireEmulator,
  requireNormalMetro,
  simulatorConfig,
  verifySimulatorPeer,
  main,
} from '../board-qa-simulator-peer';

const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

type Fault =
  | 'missing-next'
  | 'wrong-generation'
  | 'wrong-relay-writer'
  | 'missing-relay-event'
  | 'missing-relay-history'
  | 'foreign-preview'
  | 'clear-generation'
  | 'clear-unrelated'
  | 'missing-clear-event'
  | 'stale-clear-event'
  | 'peer-current-missing'
  | 'peer-current-stays'
  | 'peer-history-missing'
  | 'same-peer-relight-dedup'
  | 'retained-session'
  | 'peer-release'
  | 'stuck-leave';
function harness(fault?: Fault, peerEnabled = true) {
  vi.useFakeTimers();
  const directory = mkdtempSync(join(tmpdir(), 'boardsesh-simulator-peer-test-'));
  directories.push(directory);
  const evidence = new Evidence(directory);
  const config = simulatorConfig(EXAMPLE_CONFIG, 'emulator-5588');
  const boards: Board[] = EXAMPLE_CONFIG.boards.map((board, index) => ({
    ...board,
    uuid: `00000000-0000-4000-8000-00000000000${index}`,
    boardId: index + 1,
    layoutId: 1,
    sizeId: 1,
    setIds: '1',
    angle: 40,
    catalog: [0, 1, 2].map((climbIndex) => ({
      uuid: `climb-${index}-${climbIndex}`,
      name: `Climb ${index} ${climbIndex}`,
      frames: 'static',
      packetBytes: 40,
      commands: [{ position: index * 10 + climbIndex, r: 0, g: 252, b: 0 }],
    })),
  }));
  const status: FixtureStatus = {
    schemaVersion: 1,
    ok: true,
    requestId: 'test',
    bootId: '0123456789abcdef',
    runId: '',
    ready: true,
    firmware: 'waveshare-amoled-gym',
    firmwareBuild: 'test',
    policy: 'concurrent',
    leaseRemainingMs: 0,
    boards: boards.map((board) => ({
      uuid: board.uuid,
      connections: 0,
      handles: [],
      writes: 0,
      updates: 0,
      rejected: 0,
      sequence: 0,
      connectionHandle: 65535,
      connectionGeneration: 0,
      commands: [],
      angle: 40,
    })),
  };
  const presence = boards.map((): Snapshot => ({ holder: null, recent: [], history: [] }));
  const backendSeq = [0, 0, 0];
  const cleared = [false, false, false];
  const historyPanel: Record<Role, number | null> = { ios: null, android: null };
  const selected: Record<Role, { board: number; climb: number }> = {
    ios: { board: 0, climb: 0 },
    android: { board: 0, climb: 0 },
  };
  let driving = false,
    sessionActive = false,
    peerJoined = false,
    sessionBoard = 0;
  const timeline: string[] = [];
  const sessionId = '11111111-2222-4333-8444-555555555555';
  const users = new Map([
    [config.phones.ios.email, 'physical-user'],
    [config.phones.android.email, 'peer-user'],
  ]);
  const profiles = new Map([
    [config.phones.ios.email, { displayName: 'Holder', avatarUrl: null }],
    [config.phones.android.email, { displayName: 'Peer', avatarUrl: null }],
  ]);
  const events: Backend['events'] = [];
  const fixture = {
    request: vi.fn<Fixture['request']>().mockImplementation(async (action, boardUuid) => {
      timeline.push(`fixture:${action}:${status.boards.map((board) => board.sequence).join(',')}`);
      if (action === 'drop') {
        const board = status.boards.find((candidate) => candidate.uuid === boardUuid)!;
        board.connections = 0;
        board.handles = [];
      }
      return structuredClone(status);
    }),
    start: vi.fn<Fixture['start']>().mockImplementation(async () => {
      status.runId = 'owned-test';
      status.policy = 'last-connection-wins';
      return structuredClone(status);
    }),
  };
  const backend = {
    users,
    profiles,
    events,
    snapshot: vi.fn<Backend['snapshot']>().mockImplementation(async (board) => {
      timeline.push(`snapshot:${board.family}`);
      return structuredClone(presence[boards.indexOf(board)]);
    }),
    session: vi.fn<Backend['session']>().mockImplementation(async () => {
      timeline.push(`roster:${peerJoined ? 2 : 1}`);
      return {
        id: sessionId,
        boardPath: `/b/${boards[sessionBoard].slug}/40`,
        users: [config.phones.ios.email, ...(peerJoined ? [config.phones.android.email] : [])].map((email) => ({
          userId: users.get(email),
          username: profiles.get(email)!.displayName,
          avatarUrl: null,
          connectionState: 'CONNECTED',
        })),
      };
    }),
    query: vi.fn<Backend['query']>().mockResolvedValue({ sessionStatus: 'ended' }),
  };
  const deliver = (role: Role, boardIndex: number, climbIndex: number, report = true) => {
    const board = status.boards[boardIndex],
      climb = boards[boardIndex].catalog[climbIndex];
    for (const [otherIndex, other] of status.boards.entries())
      if (otherIndex !== boardIndex && other.connections) {
        other.connections = 0;
        other.handles = [];
        presence[otherIndex].holder = null;
      }
    if (!board.connections) {
      board.connectionGeneration++;
      board.connectionHandle = board.connectionGeneration + 7;
    }
    board.connections = 1;
    board.handles = [board.connectionHandle];
    board.sequence++;
    board.updates++;
    board.writes += 2;
    board.commands = climb.commands;
    cleared[boardIndex] = false;
    if (fault === 'wrong-generation' && role === 'ios' && climbIndex === 1) board.connectionGeneration++;
    if (report) {
      const entry = {
        climbUuid: climb.uuid,
        angle: 40,
        mirrored: false,
        sentByUserId: fault === 'wrong-relay-writer' && role === 'android' ? 'peer-user' : 'physical-user',
        seq: ++backendSeq[boardIndex],
        sentAt: new Date().toISOString(),
      };
      presence[boardIndex].holder = { userId: 'physical-user' };
      presence[boardIndex].recent.unshift(entry);
      if (!(fault === 'missing-relay-history' && role === 'android')) presence[boardIndex].history.unshift(entry);
      if (!(fault === 'missing-relay-event' && role === 'android'))
        events.push({ boardUuid: board.uuid, event: { __typename: 'BoardClimbSet', climb: entry } });
    }
  };
  const phone = (role: Role) =>
    ({
      phone: config.phones[role],
      flow: vi.fn<Driver['flow']>().mockImplementation(async (name, variables) => {
        timeline.push(`${role}:${basename(name)}`);
        const current = selected[role];
        if (basename(name) === 'inspect-record.yaml' && fault === 'retained-session')
          throw new QaFailure('Existing native session is active');
        if (name === 'open-climb') {
          const boardIndex = boards.findIndex((board) => variables?.CLIMB_URL.includes(`/b/${board.slug}/`));
          const climbIndex = boards[boardIndex].catalog.findIndex((climb) =>
            variables?.CLIMB_URL.endsWith(`/play/${climb.uuid}`),
          );
          selected[role] = { board: boardIndex, climb: climbIndex };
          historyPanel[role] = null;
          if (
            fault === 'foreign-preview' &&
            role === 'ios' &&
            status.boards.some((board, index) => index !== boardIndex && board.connections)
          )
            deliver(role, boardIndex, climbIndex);
        }
        if (name === 'return-current') selected[role] = { ...current, climb: 0 };
        if (
          (name === 'connect' || name === 'put') &&
          !(fault === 'same-peer-relight-dedup' && role === 'android' && cleared[current.board])
        )
          deliver(role, current.board, current.climb);
        if (name === 'open-history')
          historyPanel[role] = boards.findIndex((board) => board.uuid === variables?.BOARD_UUID);
        if (name === 'assert-id' && variables?.EXPECTED_ID.startsWith('board-current-')) {
          const panel = historyPanel[role];
          if (
            panel === null ||
            cleared[panel] ||
            variables.EXPECTED_ID !== `board-current-${presence[panel].recent[0]?.climbUuid}-physical-user` ||
            (fault === 'peer-current-missing' && presence[panel].recent[0]?.climbUuid === boards[panel].catalog[1].uuid)
          )
            throw new QaFailure('Expected fresh peer current hero is not visible');
        }
        if (name === 'observe-clear-history') {
          const panel = historyPanel[role];
          if (
            role !== 'android' ||
            panel === null ||
            !cleared[panel] ||
            variables?.BOARD_UUID !== boards[panel].uuid ||
            variables.CLIMB_UUID !== boards[panel].catalog[1].uuid ||
            variables.WRITER_ID !== 'physical-user' ||
            !presence[panel].history.some(
              (entry) => entry.climbUuid === variables.CLIMB_UUID && String(entry.seq) === variables.HISTORY_SEQ,
            ) ||
            fault === 'peer-current-stays' ||
            fault === 'peer-history-missing'
          )
            throw new QaFailure('Fresh peer current-to-history transition is not visible');
        }
        if (name === 'assert-id' && variables?.EXPECTED_ID === 'wall-control-crew-crew-idle') {
          if (role !== 'android' || historyPanel[role] !== null || !cleared[current.board])
            throw new QaFailure('Expected normal cleared crew control is not visible');
        }
        if (name === 'drive') {
          driving = true;
          deliver(role, current.board, current.climb, false);
        }
        if (name === 'next' && fault !== 'missing-next') {
          selected[role].climb = 1;
          deliver(role, current.board, 1);
        }
        if (name === 'stop-driving') driving = false;
        if (name === 'disconnect') {
          status.boards[current.board].connections = 0;
          status.boards[current.board].handles = [];
          presence[current.board].holder = null;
        }
        if (name === 'start-session') {
          sessionActive = true;
          sessionBoard = current.board;
        }
        if (name === 'join-session') peerJoined = true;
        if (name === 'leave-session' && fault !== 'stuck-leave') peerJoined = false;
        if (name === 'end-session') {
          sessionActive = false;
          peerJoined = false;
        }
        if (name === 'clear') {
          const board = status.boards[current.board];
          board.sequence++;
          board.updates++;
          board.writes++;
          board.commands = [];
          cleared[current.board] = true;
          if (fault === 'clear-generation') board.connectionGeneration++;
          if (fault === 'clear-unrelated') status.boards[(current.board + 1) % boards.length].writes++;
          if (fault !== 'missing-clear-event')
            events.push({
              boardUuid: board.uuid,
              event: {
                __typename: 'BoardClimbCleared',
                seq: fault === 'stale-clear-event' ? backendSeq[current.board] : ++backendSeq[current.board],
              },
            });
        }
      }),
      hierarchy: vi
        .fn<Driver['hierarchy']>()
        .mockImplementation(
          async () =>
            `app-runtime-${fault === 'peer-release' && role === 'android' ? 'release' : 'metro'}-native-test wall-control-lit-self-${driving ? 'driving' : 'idle'} ${sessionActive ? `session-active-${sessionId}` : ''}`,
        ),
      background: vi.fn<Driver['background']>().mockResolvedValue(undefined),
      foreground: vi.fn<Driver['foreground']>().mockResolvedValue(undefined),
      restart: vi.fn<Driver['restart']>().mockResolvedValue(undefined),
      screenshot: vi.fn<Driver['screenshot']>().mockResolvedValue(undefined),
      close: vi.fn<Driver['close']>().mockResolvedValue(undefined),
    }) satisfies Driver;
  const phones = { ios: phone('ios'), android: phone('android') };
  const suite = new SimulatorPeerSuite(
    config,
    peerEnabled ? phones : { ios: phones.ios },
    fixture,
    backend,
    boards,
    evidence,
    peerEnabled,
  );
  return { suite, phones, fixture, backend, status, boards, timeline, directory, evidence };
}
async function finish(work: Promise<void>): Promise<unknown> {
  const result = work.then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.runAllTimersAsync();
  return await result;
}

describe('explicit native simulator-peer preflight', () => {
  it('holder-only doctor needs no peer credentials, lease, driver, adb or Metro prerequisites', async () => {
    const current = harness(undefined, false);
    vi.useRealTimers();
    const credentials = join(current.directory, 'credentials.json');
    writeFileSync(credentials, JSON.stringify({ [EXAMPLE_CONFIG.phones.ios.email]: 'private-holder-password' }), {
      mode: 0o600,
    });
    const configPath = join(current.directory, 'config.json');
    const config = {
      ...EXAMPLE_CONFIG,
      serialPort: '/dev/unused-holder-test',
      adb: '/never/run/adb',
      credentialsFile: credentials,
      phones: {
        ios: { ...EXAMPLE_CONFIG.phones.ios, id: '00008110-0000000000000001' },
        android: { ...EXAMPLE_CONFIG.phones.android, id: 'LOCKED_PIXEL_MUST_NOT_BE_USED' },
      },
    };
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    const execute = vi.spyOn(driverTools, 'command').mockImplementation(async (executable, args) => {
      if (executable === 'git') return args[0] === 'rev-parse' ? 'host-revision' : '';
      if (executable !== 'xcrun' || args[0] !== 'devicectl') throw new Error(`Unexpected host tool ${executable}`);
      const output = args[args.indexOf('--json-output') + 1];
      if (args[1] === 'list')
        writeFileSync(
          output,
          JSON.stringify({
            result: {
              devices: [
                {
                  properties: {
                    hardware: { udid: config.phones.ios.id, reality: 'physical' },
                    connection: { transportType: 'wired', state: 'connected' },
                  },
                },
              ],
            },
          }),
        );
      else if (args.includes('apps'))
        writeFileSync(output, JSON.stringify({ result: { apps: [{ version: '2.7.0', bundleVersion: '1' }] } }));
      else throw new Error('Unexpected device action');
      return '';
    });
    const resourceLease = vi.spyOn(evidenceTools, 'lease').mockReturnValue(() => {});
    const signin = vi.spyOn(Backend.prototype, 'signIn').mockImplementation(async function (this: Backend, email) {
      this.users.set(email, 'physical-user');
      this.profiles.set(email, { displayName: 'Holder', avatarUrl: null });
    });
    vi.spyOn(Backend.prototype, 'catalog').mockResolvedValue(current.boards);
    vi.spyOn(IosDriver.prototype, 'attach').mockResolvedValue(undefined);
    vi.spyOn(IosDriver.prototype, 'flow').mockResolvedValue(undefined);
    vi.spyOn(IosDriver.prototype, 'hierarchy').mockResolvedValue('app-runtime-release-native-frozen');
    vi.spyOn(IosDriver.prototype, 'close').mockResolvedValue(undefined);
    vi.spyOn(Fixture.prototype, 'open').mockResolvedValue(undefined);
    vi.spyOn(Fixture.prototype, 'request').mockResolvedValue(current.status);
    vi.spyOn(Fixture.prototype, 'close').mockResolvedValue(undefined);
    const output = join(current.directory, 'doctor');
    expect(
      await main([
        'doctor',
        '--holder-only',
        '--config',
        configPath,
        '--metro-url',
        'not-a-url',
        '--metro-pid',
        'not-a-pid',
        '--output',
        output,
      ]),
    ).toBe(0);
    expect(signin.mock.calls).toEqual([[config.phones.ios.email, 'private-holder-password']]);
    expect(resourceLease).toHaveBeenCalledWith([config.serialPort, config.phones.ios.id]);
    expect(execute.mock.calls.every(([executable]) => ['git', 'xcrun'].includes(executable))).toBe(true);
    expect(execute.mock.calls.flatMap(([, args]) => args)).not.toContain(config.phones.android.id);
    expect(JSON.parse(readFileSync(join(output, 'coverage.json'), 'utf8'))).toMatchObject({
      verifiedPeer: false,
      selectedScopePassed: false,
      selectedCaseCount: 6,
      allMatrixPassed: false,
    });
    await expect(main(['doctor', '--config', configPath])).rejects.toThrow('explicit Android emulator');
  });
  it('requires the exact ready emulator and positive virtual-machine property', () => {
    expect(() =>
      requireEmulator('emulator-5588 device product:sdk\nphysical device usb:1', 'emulator-5588', '1\n'),
    ).not.toThrow();
    for (const [serial, qemu, inventory] of [
      ['physical', '1', 'physical device'],
      ['emulator-5588', '0', 'emulator-5588 device'],
      ['emulator-5588', '1', 'emulator-5554 device'],
      ['emulator-5588', '1', 'emulator-5588 offline'],
    ])
      expect(() => requireEmulator(inventory, serial, qemu)).toThrow('exact ready Android emulator');
  });
  it('requires explicit normal-mode flags and production backend without echoing private environment', () => {
    const normal =
      'node EXPO_PUBLIC_SCREENSHOT_MODE=0 EXPO_PUBLIC_SCREENSHOT_FAKE_BLE=0 EXPO_PUBLIC_BACKEND_URL=https://ws.boardsesh.com PASSWORD=private';
    expect(() => requireNormalMetro(normal)).not.toThrow();
    for (const invalid of [
      normal.replace('MODE=0', 'MODE=1'),
      normal.replace('FAKE_BLE=0', 'FAKE_BLE=1'),
      normal.replace('https://ws.boardsesh.com', 'http://localhost:3002'),
      'PASSWORD=private',
    ]) {
      try {
        requireNormalMetro(invalid);
        throw new Error('expected rejection');
      } catch (error) {
        expect(String(error)).not.toContain('private');
        expect(error).toBeInstanceOf(QaFailure);
      }
    }
  });
  it('keeps the original config and full-matrix verdict separate', () => {
    const selected = simulatorConfig(EXAMPLE_CONFIG, 'emulator-5588');
    expect(EXAMPLE_CONFIG.phones.android.id).toBe('YOUR_ANDROID_SERIAL');
    expect(selected.phones.android.id).toBe('emulator-5588');
    const coverage = fallbackCoverage(selected);
    expect(coverage.allMatrixPassed).toBe(false);
    expect(coverage.participants.peer).toMatchObject({ deviceKind: 'emulator', bluetoothHolder: false });
    expect(coverage.unrun).toHaveLength(4);
    expect(() => simulatorConfig(EXAMPLE_CONFIG, 'physical-adb-id')).toThrow('explicit Android emulator');
  });
  it('binds only the exact emulator package to normal Metro without recording login or clearing storage', async () => {
    const selected = simulatorConfig(EXAMPLE_CONFIG, 'emulator-5588');
    const execute = vi.fn().mockResolvedValue('Status: ok\nActivity: com.boardsesh.app.dev/.MainActivity');
    expect(await bindSimulatorMetro(selected, '8179', execute)).toBe('http://127.0.0.1:8179');
    expect(execute.mock.calls.map(([, args]) => args)).toEqual([
      ['-s', 'emulator-5588', 'reverse', '--list'],
      ['-s', 'emulator-5588', 'reverse', '--no-rebind', 'tcp:8179', 'tcp:8179'],
      ['-s', 'emulator-5588', 'shell', 'am', 'force-stop', selected.phones.android.appId],
      [
        '-s',
        'emulator-5588',
        'shell',
        'am',
        'start',
        '-W',
        '-a',
        'android.intent.action.VIEW',
        '-d',
        "'com.boardsesh.app://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8179'",
        '-p',
        "'com.boardsesh.app.dev'",
      ],
    ]);
    expect(execute.mock.calls.flat().join(' ')).not.toContain(EXAMPLE_CONFIG.phones.ios.id);
    await expect(
      bindSimulatorMetro(selected, '8179', vi.fn().mockResolvedValue('Error: Activity not found')),
    ).rejects.toMatchObject({ kind: 'blocked' });
    await expect(
      bindSimulatorMetro(
        selected,
        '8179',
        vi.fn().mockResolvedValue('Status: ok\nActivity: com.boardsesh.app/.MainActivity'),
      ),
    ).rejects.toMatchObject({ kind: 'blocked' });
  });
  it('refuses conflicting reverse mappings and invalid schemes before restarting the emulator', async () => {
    const selected = simulatorConfig(EXAMPLE_CONFIG, 'emulator-5588');
    const execute = vi.fn().mockResolvedValue('host-12 tcp:8179 tcp:9999');
    await expect(bindSimulatorMetro(selected, '8179', execute)).rejects.toMatchObject({ kind: 'blocked' });
    expect(execute).toHaveBeenCalledTimes(1);
    const invalid = {
      ...selected,
      phones: { ...selected.phones, android: { ...selected.phones.android, scheme: "bad';scheme" } },
    };
    execute.mockClear();
    await expect(bindSimulatorMetro(invalid, '8179', execute)).rejects.toMatchObject({ kind: 'blocked' });
    expect(execute).not.toHaveBeenCalled();
    await expect(bindSimulatorMetro(selected, '65536', execute)).rejects.toMatchObject({ kind: 'blocked' });
    expect(execute).not.toHaveBeenCalled();
  });
  it('reuses the exact matching reverse mapping without replacing it', async () => {
    const selected = simulatorConfig(EXAMPLE_CONFIG, 'emulator-5588');
    const execute = vi
      .fn()
      .mockResolvedValue('Status: ok\nActivity: com.boardsesh.app.dev/.MainActivity')
      .mockResolvedValueOnce('host-12 tcp:8179 tcp:8179');
    await expect(bindSimulatorMetro(selected, '8179', execute)).resolves.toBe('http://127.0.0.1:8179');
    expect(execute.mock.calls.some(([, args]) => args.includes('--no-rebind'))).toBe(false);
  });
  it('waits for actual normal navigation before account identity, blocking a blank native activity', async () => {
    const current = harness();
    const order: string[] = [];
    current.phones.android.flow.mockImplementation(async () => {
      order.push('normal-ui-ready');
    });
    const identity = vi.fn<SimulatorPeerSuite['identity']>().mockImplementation(async () => {
      order.push('account');
    });
    await verifySimulatorPeer({ identity }, current.phones.android);
    expect(order).toEqual(['normal-ui-ready', 'account']);
    expect(current.phones.android.flow).toHaveBeenCalledWith('wait-app-ready');
    identity.mockClear();
    current.phones.android.flow.mockRejectedValue(new QaFailure('No rendered app UI'));
    await expect(verifySimulatorPeer({ identity }, current.phones.android)).rejects.toMatchObject({ kind: 'blocked' });
    expect(identity).not.toHaveBeenCalled();
  });
});

describe('physical iPhone with native emulator peer schedule', () => {
  it('runs exactly six holder-only cases and six captures without any peer driver method', async () => {
    const current = harness(undefined, false);
    for (const method of Object.values(current.phones.android))
      if (typeof method === 'function')
        vi.mocked(method).mockImplementation(() => {
          throw new Error('Peer must never be touched');
        });
    expect(
      await finish(
        (async () => {
          await current.suite.prepare();
          await current.suite.solo();
          await current.suite.isolation();
          await current.suite.cleanup();
          await current.suite.failureArtifacts();
        })(),
      ),
    ).toBeUndefined();
    expect(current.evidence.results).toHaveLength(6);
    expect(current.evidence.results.every((result) => result.verdict === 'passed')).toBe(true);
    expect(current.phones.ios.screenshot.mock.calls.filter(([name]) => name.startsWith('fallback-'))).toHaveLength(6);
    for (const method of Object.values(current.phones.android))
      if (typeof method === 'function') expect(method).not.toHaveBeenCalled();
    await expect(current.suite.sessions()).rejects.toMatchObject({ kind: 'blocked' });
    const coverage = fallbackCoverage(EXAMPLE_CONFIG, false);
    expect(coverage).toMatchObject({
      profile: 'physical-ios-holder-only',
      selectedCaseCount: 6,
      verifiedPeer: false,
      allMatrixPassed: false,
    });
    expect(coverage.participants).not.toHaveProperty('peer');
    expect(coverage.unrun.join(' ')).toContain('All crew');
  });
  it('blocks a peer release runtime after the Metro launch instead of accepting the installed app', async () => {
    const current = harness('peer-release');
    expect(await finish(current.suite.prepare())).toMatchObject({ kind: 'blocked' });
    expect(current.fixture.start).not.toHaveBeenCalled();
  });
  it('runs all three families while only iPhone owns BLE and peer requests retain physical writer evidence', async () => {
    const current = harness();
    expect(
      await finish(
        (async () => {
          await current.suite.prepare();
          await current.suite.solo();
          await current.suite.isolation();
          await current.suite.sessions();
          await current.suite.cleanup();
        })(),
      ),
    ).toBeUndefined();
    expect(current.evidence.results).toHaveLength(9);
    expect(current.evidence.results.every((result) => result.verdict === 'passed')).toBe(true);
    const peerFlows = current.phones.android.flow.mock.calls.map(([name]) => name);
    expect(peerFlows.filter((name) => name === 'put')).toHaveLength(6);
    expect(
      peerFlows.some((name) =>
        ['connect', 'select-device', 'drive', 'clear', 'disconnect', 'confirm-takeover'].includes(name),
      ),
    ).toBe(false);
    expect(current.phones.ios.background).not.toHaveBeenCalled();
    expect(current.phones.android.background).not.toHaveBeenCalled();
    expect(current.phones.ios.restart).toHaveBeenCalledTimes(9);
    expect(current.status.boards.every((board) => board.connections === 0)).toBe(true);
    const reports = readFileSync(join(current.directory, 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string; payload: { participant?: string; writer?: string } });
    expect(
      reports.filter((event) => event.kind === 'confirmed-send' && event.payload.participant === 'simulator-peer'),
    ).toHaveLength(6);
    expect(
      reports
        .filter((event) => event.kind === 'confirmed-send')
        .every((event) => event.payload.writer === 'physical-ios'),
    ).toBe(true);
    expect(current.backend.session.mock.calls.length).toBeGreaterThanOrEqual(12);
  });
  it.each(['missing-next', 'wrong-generation'] as const)(
    'refuses %s instead of accepting preview/setup as Next',
    async (fault) => {
      const current = harness(fault);
      expect(await finish(current.suite.solo())).toBeInstanceOf(QaFailure);
      expect(current.phones.ios.flow.mock.calls.some(([name]) => name === 'stop-driving')).toBe(false);
    },
  );
  it.each(['wrong-relay-writer', 'missing-relay-event', 'missing-relay-history', 'clear-generation'] as const)(
    'refuses %s despite a changed peripheral',
    async (fault) => {
      const current = harness(fault);
      expect(await finish(current.suite.sessions())).toBeInstanceOf(QaFailure);
      expect(current.evidence.results[0].verdict).toBe('failed');
    },
  );
  it('observes the fresh peer current hero move to its exact history sequence before SAME-peer relight', async () => {
    const current = harness();
    expect(await finish(current.suite.sessions())).toBeUndefined();
    const peerFlows = current.phones.android.flow.mock.calls;
    for (const board of current.boards) {
      const observed = peerFlows.findIndex(
        ([name, variables]) => name === 'observe-clear-history' && variables?.BOARD_UUID === board.uuid,
      );
      expect(observed).toBeGreaterThan(0);
      expect(peerFlows[observed]).toEqual([
        'observe-clear-history',
        {
          BOARD_UUID: board.uuid,
          CLIMB_UUID: board.catalog[1].uuid,
          WRITER_ID: 'physical-user',
          HISTORY_SEQ: '2',
        },
      ]);
      expect(peerFlows[observed - 1]).toEqual([
        'assert-id',
        { EXPECTED_ID: `board-current-${board.catalog[1].uuid}-physical-user` },
      ]);
      expect(peerFlows.slice(observed + 1, observed + 4).map(([name]) => name)).toEqual([
        'open-climb',
        'assert-id',
        'put',
      ]);
      expect(peerFlows[observed + 2]).toEqual(['assert-id', { EXPECTED_ID: 'wall-control-crew-crew-idle' }]);
    }
    expect(peerFlows.some(([, variables]) => variables?.EXPECTED_ID === 'wall-control-dark-crew-idle')).toBe(false);
    const commands = readFlow('packages/mobile/.maestro/board-qa/observe-clear-history.yaml', {
      APP_ID: current.phones.android.phone.appId,
      BOARD_UUID: 'wall',
      CLIMB_UUID: 'B',
      WRITER_ID: 'holder',
      HISTORY_SEQ: '2',
    });
    expect(commands[0]).toEqual({ assertVisible: { id: 'board-panel-wall' } });
    expect(commands[1]).toEqual({
      extendedWaitUntil: { notVisible: { id: 'board-current-B-holder' }, timeout: 30000 },
    });
    expect(commands.filter((step) => 'runFlow' in step)).toHaveLength(3);
    expect(commands.at(-1)).toEqual({ extendedWaitUntil: { visible: { id: 'board-history-B-2' }, timeout: 30000 } });
  });
  it.each([
    'clear-unrelated',
    'missing-clear-event',
    'stale-clear-event',
    'peer-current-missing',
    'peer-current-stays',
    'peer-history-missing',
  ] as const)('blocks %s before the second peer Put', async (fault) => {
    const current = harness(fault);
    expect(await finish(current.suite.sessions())).toBeInstanceOf(QaFailure);
    expect(current.phones.android.flow.mock.calls.filter(([name]) => name === 'put')).toHaveLength(1);
  });
  it('fails when SAME-peer relight produces no fresh physical send', async () => {
    const current = harness('same-peer-relight-dedup');
    expect(await finish(current.suite.sessions())).toBeInstanceOf(QaFailure);
    expect(current.phones.android.flow.mock.calls.filter(([name]) => name === 'put')).toHaveLength(2);
    expect(current.phones.ios.flow.mock.calls.some(([name]) => name === 'put')).toBe(false);
    expect(current.phones.android.flow.mock.calls.some(([name]) => name === 'leave-session')).toBe(false);
  });
  it('detects destination writes before establishing a fresh move baseline', async () => {
    const current = harness('foreign-preview');
    const error = await finish(current.suite.isolation());
    expect(String(error)).toContain('Foreign preview prematurely wrote');
    expect(current.phones.ios.flow.mock.calls.some(([name]) => name === 'put')).toBe(false);
  });
  it('observes one member after Leave before allowing the next Join', async () => {
    const current = harness();
    expect(await finish(current.suite.sessions())).toBeUndefined();
    for (const [index, step] of current.timeline.entries())
      if (step === 'android:leave-session') {
        const nextJoin = current.timeline.indexOf('android:join-session', index + 1);
        expect(nextJoin).toBeGreaterThan(index);
        expect(current.timeline.slice(index + 1, nextJoin)).toContain('roster:1');
      }
    const generated = readFlow(join(current.directory, 'inspect-record.yaml'), {
      APP_ID: EXAMPLE_CONFIG.phones.ios.appId,
      RECORD_URL: 'com.boardsesh.app://record',
    });
    expect(generated).toEqual([
      { openLink: 'com.boardsesh.app://record' },
      { extendedWaitUntil: { visible: { id: 'session-start' }, timeout: 10000 } },
      { assertNotVisible: { id: 'session-active-.+' } },
    ]);
  });
  it('refuses rejoin when Leave never removes the peer from the live roster', async () => {
    const current = harness('stuck-leave');
    expect(await finish(current.suite.sessions())).toBeInstanceOf(QaFailure);
    expect(current.phones.android.flow.mock.calls.filter(([name]) => name === 'join-session')).toHaveLength(1);
    expect(current.phones.ios.flow.mock.calls.some(([name]) => name === 'end-session')).toBe(false);
  });
  it('never restarts a holder when another board has a live link', async () => {
    const current = harness();
    current.status.boards[2].connections = 1;
    expect(await finish(current.suite.solo())).toMatchObject({ kind: 'blocked' });
    expect(current.phones.ios.restart).not.toHaveBeenCalled();
  });
  it('never restarts a holder while the real Record UI reports a retained session', async () => {
    const current = harness('retained-session');
    expect(await finish(current.suite.solo())).toMatchObject({ kind: 'blocked' });
    expect(current.phones.ios.restart).not.toHaveBeenCalled();
  });
});
