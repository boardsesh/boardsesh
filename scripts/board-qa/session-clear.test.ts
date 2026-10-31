import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Backend, Snapshot } from './backend';
import { EXAMPLE_CONFIG, type Board, type Role } from './config';
import { readFlow, type Driver } from './drivers';
import type { Fixture, FixtureStatus } from './fixture';
import { Evidence, QaFailure } from './evidence';
import { Suite } from './suite';

const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});
type Fault =
  | 'different-clear-generation'
  | 'unrelated-clear'
  | 'missing-clear-event'
  | 'peer-current-stays'
  | 'peer-history-missing'
  | 'same-peer-relight-dedup';
function harness(fault?: Fault) {
  vi.useFakeTimers();
  const path = mkdtempSync(join(tmpdir(), 'board-qa-session-clear-'));
  directories.push(path);
  const evidence = new Evidence(path);
  const board: Board = {
    ...EXAMPLE_CONFIG.boards[0],
    uuid: '11111111-2222-4333-8444-555555555555',
    boardId: 1,
    layoutId: 1,
    sizeId: 1,
    setIds: '1',
    angle: 40,
    catalog: [0, 1, 2].map((index) => ({
      uuid: `climb-${index}`,
      name: `Climb ${index}`,
      frames: 'static',
      packetBytes: 8,
      commands: [{ position: index, r: 0, g: 252, b: 0 }],
    })),
  };
  const other: Board = { ...board, uuid: '22222222-2222-4333-8444-555555555555', family: 'tension' };
  const status: FixtureStatus = {
    schemaVersion: 1,
    ok: true,
    requestId: 'test',
    bootId: '0123456789abcdef',
    runId: 'session-clear-test',
    ready: true,
    firmware: 'waveshare-amoled-gym',
    firmwareBuild: 'test',
    policy: 'last-connection-wins',
    leaseRemainingMs: 30000,
    boards: [board, other].map((item) => ({
      uuid: item.uuid,
      connections: 0,
      handles: [],
      writes: 0,
      updates: 0,
      sequence: 0,
      rejected: 0,
      connectionHandle: 65535,
      connectionGeneration: 0,
      commands: [],
      angle: 40,
    })),
  };
  const physical = status.boards[0],
    presence: Snapshot = { holder: null, recent: [], history: [] };
  const events: Backend['events'] = [];
  const selected: Record<Role, number> = { ios: 0, android: 0 };
  const timeline: string[] = [];
  let serverSeq = 0,
    sessionActive = false,
    cleared = false,
    peerPuts = 0;
  const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const users = new Map([
    [EXAMPLE_CONFIG.phones.ios.email, 'holder'],
    [EXAMPLE_CONFIG.phones.android.email, 'peer'],
  ]);
  const profiles = new Map([
    [EXAMPLE_CONFIG.phones.ios.email, { displayName: 'Holder', avatarUrl: null }],
    [EXAMPLE_CONFIG.phones.android.email, { displayName: 'Peer', avatarUrl: null }],
  ]);
  const deliver = (index: number) => {
    physical.connections = 1;
    physical.handles = [8];
    physical.connectionHandle = 8;
    physical.connectionGeneration ||= 1;
    physical.sequence++;
    physical.updates++;
    physical.writes++;
    physical.commands = board.catalog[index].commands;
    const entry = {
      climbUuid: board.catalog[index].uuid,
      angle: 40,
      mirrored: false,
      sentByUserId: 'holder',
      seq: ++serverSeq,
      sentAt: new Date().toISOString(),
    };
    presence.holder = { userId: 'holder' };
    presence.recent.unshift(entry);
    presence.history.unshift(entry);
    events.push({ boardUuid: board.uuid, event: { __typename: 'BoardClimbSet', climb: entry } });
  };
  const finished = new Error('Stop after the same peer relight completed its full chain');
  const fixture = {
    request: vi.fn<Fixture['request']>().mockImplementation(async (action) => {
      if (action === 'drop') throw finished;
      return structuredClone(status);
    }),
  };
  const backend = {
    users,
    profiles,
    events,
    snapshot: vi.fn<Backend['snapshot']>().mockImplementation(async () => structuredClone(presence)),
    session: vi.fn<Backend['session']>().mockResolvedValue({
      id: sessionId,
      boardPath: `/b/${board.slug}/40`,
      users: [
        { userId: 'holder', username: 'Holder', avatarUrl: null, connectionState: 'CONNECTED' },
        { userId: 'peer', username: 'Peer', avatarUrl: null, connectionState: 'CONNECTED' },
      ],
    }),
  };
  const phone = (role: Role) =>
    ({
      phone: EXAMPLE_CONFIG.phones[role],
      flow: vi.fn<Driver['flow']>().mockImplementation(async (name, variables) => {
        timeline.push(`${role}:${name}`);
        if (name === 'open-climb')
          selected[role] = board.catalog.findIndex((climb) => variables?.CLIMB_URL.endsWith(`/play/${climb.uuid}`));
        if (name === 'connect') deliver(selected[role]);
        if (name === 'put') {
          if (role !== 'android') throw new Error('Relight actor changed');
          peerPuts++;
          if (!(cleared && fault === 'same-peer-relight-dedup')) deliver(selected[role]);
        }
        if (name === 'start-session') sessionActive = true;
        if (name === 'clear') {
          cleared = true;
          physical.sequence++;
          physical.updates++;
          physical.writes++;
          physical.commands = [];
          if (fault === 'different-clear-generation') physical.connectionGeneration++;
          if (fault === 'unrelated-clear') status.boards[1].writes++;
          if (fault !== 'missing-clear-event')
            events.push({ boardUuid: board.uuid, event: { __typename: 'BoardClimbCleared', seq: ++serverSeq } });
        }
        if (name === 'observe-clear-history') {
          expect(variables).toEqual({
            BOARD_UUID: board.uuid,
            CLIMB_UUID: 'climb-1',
            WRITER_ID: 'holder',
            HISTORY_SEQ: '2',
          });
          if (fault === 'peer-current-stays' || fault === 'peer-history-missing')
            throw new QaFailure('Peer clear transition is not visible');
        }
      }),
      hierarchy: vi
        .fn<Driver['hierarchy']>()
        .mockImplementation(async () => `app-runtime-metro-test ${sessionActive ? `session-active-${sessionId}` : ''}`),
      restart: vi.fn<Driver['restart']>().mockResolvedValue(undefined),
      foreground: vi.fn<Driver['foreground']>(),
      background: vi.fn<Driver['background']>(),
      screenshot: vi.fn<Driver['screenshot']>(),
      close: vi.fn<Driver['close']>(),
    }) satisfies Driver;
  const phones = { ios: phone('ios'), android: phone('android') };
  const suite = new Suite(
    EXAMPLE_CONFIG,
    phones,
    fixture as unknown as Fixture,
    backend as unknown as Backend,
    [board, other],
    evidence,
  );
  return {
    suite,
    phones,
    timeline,
    finished,
    get peerPuts() {
      return peerPuts;
    },
  };
}
async function finish(work: Promise<void>): Promise<unknown> {
  const result = work.then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.runAllTimersAsync();
  return await result;
}

describe('shared clear observation without an impossible remote dark state', () => {
  it('proves fresh current B before clear, observes that same B in history, restores its preview and keeps the SAME peer relight', async () => {
    const current = harness();
    expect(await finish(current.suite.sessions())).toBe(current.finished);
    expect(current.peerPuts).toBe(2);
    const before = current.timeline.indexOf('ios:clear'),
      observed = current.timeline.indexOf('android:observe-clear-history');
    expect(observed).toBeGreaterThan(before);
    const roleFlows = current.phones.android.flow.mock.calls;
    expect(
      roleFlows.some(
        ([name, variables]) => name === 'assert-id' && variables?.EXPECTED_ID === 'board-current-climb-1-holder',
      ),
    ).toBe(true);
    expect(roleFlows).toContainEqual(['assert-id', { EXPECTED_ID: 'wall-control-crew-crew-idle' }]);
    expect(current.phones.ios.flow.mock.calls).toContainEqual([
      'assert-id',
      { EXPECTED_ID: 'wall-control-dark-self-idle' },
    ]);
    const afterObservation = current.timeline.slice(observed + 1);
    expect(afterObservation.indexOf('android:open-climb')).toBeLessThan(afterObservation.indexOf('android:put'));
    expect(roleFlows.some(([, variables]) => variables?.EXPECTED_ID === 'wall-control-dark-crew-idle')).toBe(false);
  });
  it.each([
    'different-clear-generation',
    'unrelated-clear',
    'missing-clear-event',
    'peer-current-stays',
    'peer-history-missing',
  ] as const)('refuses %s before the second peer Put', async (fault) => {
    const current = harness(fault);
    expect(await finish(current.suite.sessions())).toBeInstanceOf(QaFailure);
    expect(current.peerPuts).toBe(1);
  });
  it('continues to fail if the same peer Put is deduplicated instead of physically relighting', async () => {
    const current = harness('same-peer-relight-dedup');
    expect(await finish(current.suite.sessions())).toBeInstanceOf(QaFailure);
    expect(current.peerPuts).toBe(2);
  });
  it('requires top-position current absence before any bounded real scrolling for the exact known history seq', () => {
    const commands = readFlow(resolve('packages/mobile/.maestro/board-qa/observe-clear-history.yaml'), {
      APP_ID: 'com.boardsesh.app',
      BOARD_UUID: 'wall',
      CLIMB_UUID: 'B',
      WRITER_ID: 'holder',
      HISTORY_SEQ: '42',
    });
    expect(commands[0]).toEqual({ assertVisible: { id: 'board-panel-wall' } });
    expect(commands[1]).toEqual({
      extendedWaitUntil: { notVisible: { id: 'board-current-B-holder' }, timeout: 30000 },
    });
    expect(commands.filter((step) => 'runFlow' in step)).toHaveLength(3);
    expect(commands.at(-1)).toEqual({ extendedWaitUntil: { visible: { id: 'board-history-B-42' }, timeout: 30000 } });
  });
});
