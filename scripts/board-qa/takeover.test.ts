import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Backend, Snapshot } from './backend';
import { EXAMPLE_CONFIG, type Board, type Role } from './config';
import type { Driver } from './drivers';
import type { Fixture, FixtureBoard, FixtureStatus } from './fixture';
import { requireTakeoverBaseline } from './confirmation';
import { Evidence, QaFailure } from './evidence';
import { Suite } from './suite';

const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});
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
const peerWriter: FixtureBoard = {
  uuid: board.uuid,
  connections: 1,
  handles: [8],
  writes: 4,
  updates: 4,
  sequence: 4,
  rejected: 0,
  connectionHandle: 8,
  connectionGeneration: 2,
  commands: board.catalog[2].commands,
  angle: 40,
};
const peerPresence: Snapshot = {
  holder: { userId: 'peer' },
  recent: [
    { climbUuid: 'climb-2', angle: 40, mirrored: false, sentByUserId: 'peer', seq: 10, sentAt: '2026-10-31T16:00:00Z' },
  ],
  history: [],
};

describe('physical takeover precondition', () => {
  it('requires the live peer writer and the same climb, independent of a busy-wall question', () => {
    expect(() => requireTakeoverBaseline(peerWriter, peerPresence, board.catalog[2], 'peer', 40)).not.toThrow();
  });
  it.each([
    ['no physical link', { connections: 0, handles: [] }],
    ['multiple links', { connections: 2, handles: [8, 9] }],
    ['inactive writer handle', { connectionHandle: 9 }],
    ['missing generation', { connectionGeneration: 0 }],
    ['different physically lit climb', { commands: board.catalog[0].commands }],
  ] satisfies Array<[string, Partial<FixtureBoard>]>)('rejects %s', (_name, changed) => {
    expect(() =>
      requireTakeoverBaseline({ ...peerWriter, ...changed }, peerPresence, board.catalog[2], 'peer', 40),
    ).toThrow(QaFailure);
  });
  it.each([
    ['missing holder', { holder: null }],
    ['wrong holder', { holder: { userId: 'requester' } }],
    ['no current climb', { recent: [] }],
    ['different current climb', { recent: [{ ...peerPresence.recent[0], climbUuid: 'climb-0' }] }],
    ['wrong current writer', { recent: [{ ...peerPresence.recent[0], sentByUserId: 'requester' }] }],
  ] satisfies Array<[string, Partial<Snapshot>]>)('rejects %s', (_name, changed) => {
    expect(() =>
      requireTakeoverBaseline(peerWriter, { ...peerPresence, ...changed }, board.catalog[2], 'peer', 40),
    ).toThrow(QaFailure);
  });
});

type Fault =
  | 'missing-peer'
  | 'wrong-writer'
  | 'busy-question'
  | 'old-generation'
  | 'missing-history'
  | 'blank-old-ui'
  | 'old-writer-reassert';
function harness(remembered = false, fault?: Fault) {
  vi.useFakeTimers();
  const directory = mkdtempSync(join(tmpdir(), 'boardsesh-takeover-test-'));
  directories.push(directory);
  const evidence = new Evidence(directory);
  const physical: FixtureBoard = {
    ...peerWriter,
    connections: 0,
    handles: [],
    writes: 0,
    updates: 0,
    sequence: 0,
    connectionGeneration: 0,
    connectionHandle: 65535,
    commands: [],
  };
  const status: FixtureStatus = {
    schemaVersion: 1,
    ok: true,
    requestId: 'test',
    bootId: '0123456789abcdef',
    runId: 'takeover-test',
    ready: true,
    firmware: 'waveshare-amoled-gym',
    firmwareBuild: 'test',
    policy: 'last-connection-wins',
    leaseRemainingMs: 30000,
    boards: [physical],
  };
  const presence: Snapshot = { holder: null, recent: [], history: [] };
  const selected: Record<Role, number> = { ios: 0, android: 0 };
  const driving: Record<Role, boolean> = { ios: false, android: false };
  const identities = { ios: 'requester', android: 'peer' };
  const timeline: string[] = [];
  let pendingPicker = false,
    busyQuestion = false,
    takeoverAttempted = false,
    takenOver = false,
    peerSetupDone = false;
  const events: Backend['events'] = [];
  const deliver = (role: Role, index: number, report = true, connecting = false) => {
    if (connecting) {
      if (!(fault === 'old-generation' && takeoverAttempted)) physical.connectionGeneration++;
      physical.connectionHandle = physical.connectionGeneration + 7;
      driving[role === 'ios' ? 'android' : 'ios'] = false;
    }
    physical.connections = 1;
    physical.handles = [physical.connectionHandle];
    physical.sequence++;
    physical.updates++;
    physical.writes++;
    physical.commands = board.catalog[index].commands;
    if (takeoverAttempted && role === 'ios' && connecting) takenOver = true;
    if (report) {
      const entry = {
        climbUuid: board.catalog[index].uuid,
        angle: 40,
        mirrored: false,
        sentByUserId: identities[role],
        seq: (presence.recent[0]?.seq ?? 0) + 1,
        sentAt: new Date().toISOString(),
      };
      presence.holder = { userId: identities[role] };
      presence.recent.unshift(entry);
      if (!(takenOver && fault === 'missing-history')) presence.history.unshift(entry);
      events.push({ boardUuid: board.uuid, event: { __typename: 'BoardClimbSet', climb: entry } });
    }
  };
  const fixture = {
    request: vi.fn<Fixture['request']>().mockImplementation(async () => {
      timeline.push(`physical:${physical.sequence}:${physical.connectionGeneration}`);
      return structuredClone(status);
    }),
  };
  const backend = {
    users: new Map([
      [EXAMPLE_CONFIG.phones.ios.email, 'requester'],
      [EXAMPLE_CONFIG.phones.android.email, 'peer'],
    ]),
    events,
    snapshot: vi.fn<Backend['snapshot']>().mockImplementation(async () => {
      timeline.push(`presence:${presence.holder?.userId ?? 'none'}`);
      return structuredClone(presence);
    }),
  };
  const finished = new Error('Stop after the first complete takeover case');
  const phone = (role: Role) =>
    ({
      phone: EXAMPLE_CONFIG.phones[role],
      flow: vi.fn<Driver['flow']>().mockImplementation(async (name, variables) => {
        timeline.push(`${role}:${name}`);
        if (name === 'open-climb') {
          selected[role] = board.catalog.findIndex((climb) => variables?.CLIMB_URL.endsWith(`/play/${climb.uuid}`));
          if (role === 'ios' && presence.holder?.userId === 'peer') {
            if (fault === 'missing-peer') presence.holder = null;
            if (fault === 'wrong-writer') physical.connectionHandle = 65534;
          }
        }
        if (name === 'return-current') selected[role] = 0;
        if (name === 'connect') {
          if (role === 'ios' && physical.connections === 1 && presence.holder?.userId === 'peer') {
            takeoverAttempted = true;
            if (!peerSetupDone || !driving.android) throw new Error('Peer was not driving before takeover');
            if (fault === 'old-writer-reassert') deliver('android', 2, false);
            if (fault === 'busy-question') busyQuestion = true;
            else if (remembered) deliver(role, selected[role], true, true);
            else pendingPicker = true;
          } else {
            deliver(role, selected[role], true, true);
            driving[role] = false;
          }
        }
        if (name === 'select-device') {
          if (variables?.BOARD_UUID !== board.uuid || !pendingPicker)
            throw new Error('Wrong or unnecessary picker selection');
          pendingPicker = false;
          deliver(role, selected[role], true, true);
        }
        if (name === 'drive') {
          driving[role] = true;
          deliver(role, selected[role], false);
          if (role === 'android') peerSetupDone = true;
        }
        if (name === 'next') {
          if (!driving[role]) throw new Error('Not driving');
          selected[role] = 1;
          deliver(role, 1);
        }
        if (name === 'stop-driving') driving[role] = false;
        if (name === 'put') deliver(role, selected[role]);
        if (name === 'disconnect') {
          physical.connections = 0;
          physical.handles = [];
          presence.holder = null;
        }
        if (name === 'assert-id' && takenOver && role === 'android' && fault === 'blank-old-ui')
          throw new QaFailure('Old phone wall control is absent');
      }),
      hierarchy: vi.fn<Driver['hierarchy']>().mockImplementation(async () => {
        if (role === 'ios' && busyQuestion) return 'busy-wall-question';
        if (role === 'ios' && pendingPicker) return `ble-device-${board.uuid}`;
        if (role === 'android' && takenOver && fault === 'blank-old-ui') return '';
        const owner = presence.holder?.userId === identities[role] ? 'self' : 'none';
        return `wall-control-lit-${owner}-${driving[role] ? 'driving' : 'idle'}`;
      }),
      restart: vi.fn<Driver['restart']>().mockRejectedValue(finished),
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
    [board],
    evidence,
  );
  return {
    suite,
    phones,
    status,
    directory,
    timeline,
    finished,
    get takenOver() {
      return takenOver;
    },
  };
}
async function finish(work: Promise<void>): Promise<unknown> {
  const result = work.then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.runAllTimersAsync();
  return result;
}

describe('same-climb physical takeover through normal connection UI', () => {
  it.each([false, true])(
    'drives the peer, then confirms a new writer via %s remembered-device path without a modal',
    async (remembered) => {
      const current = harness(remembered);
      expect(await finish(current.suite.solo())).toBe(current.finished);
      expect(current.takenOver).toBe(true);
      expect(current.phones.ios.flow.mock.calls.filter(([name]) => name === 'select-device')).toHaveLength(
        remembered ? 0 : 1,
      );
      expect(current.phones.ios.flow.mock.calls.map(([name]) => name)).not.toContain('confirm-takeover');
      expect(current.timeline.indexOf('android:drive')).toBeLessThan(current.timeline.lastIndexOf('ios:connect'));
      expect(current.phones.android.flow).toHaveBeenCalledWith('assert-id', {
        EXPECTED_ID: 'wall-control-.*-(none|crew)-idle',
      });
      expect(current.status.boards[0].connections).toBe(0);
      const events = readFileSync(join(current.directory, 'events.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(
          (line) => JSON.parse(line) as { kind: string; payload: { writer?: string; connectionGeneration?: number } },
        );
      const confirmations = events.filter((event) => event.kind === 'confirmed-send');
      expect(confirmations).toHaveLength(5);
      expect(confirmations.at(-1)?.payload).toMatchObject({ writer: 'ios', connectionGeneration: 3 });
    },
  );
  it.each(['missing-peer', 'wrong-writer'] as const)('rejects %s before the requester taps Connect', async (fault) => {
    const current = harness(false, fault);
    expect(await finish(current.suite.solo())).toMatchObject({ kind: 'blocked' });
    expect(current.phones.ios.flow.mock.calls.filter(([name]) => name === 'connect')).toHaveLength(1);
    expect(current.phones.ios.flow.mock.calls.some(([name]) => name === 'select-device')).toBe(false);
  });
  it('rejects an unexpected crew question without answering it', async () => {
    const current = harness(false, 'busy-question');
    expect(await finish(current.suite.solo())).toMatchObject({ kind: 'blocked' });
    expect(current.takenOver).toBe(false);
    expect(
      current.phones.ios.flow.mock.calls.some(([name]) => name === 'select-device' || name === 'confirm-takeover'),
    ).toBe(false);
  });
  it('does not mistake a fresh old-writer reassert for a remembered takeover connection', async () => {
    const current = harness(false, 'old-writer-reassert');
    expect(await finish(current.suite.solo())).toBe(current.finished);
    expect(current.phones.ios.flow.mock.calls.filter(([name]) => name === 'select-device')).toHaveLength(1);
    expect(current.takenOver).toBe(true);
  });
  it.each(['old-generation', 'missing-history', 'blank-old-ui'] as const)(
    'rejects %s despite apparent takeover progress',
    async (fault) => {
      const current = harness(false, fault);
      expect(await finish(current.suite.solo())).toBeInstanceOf(QaFailure);
      expect(current.phones.ios.restart).not.toHaveBeenCalled();
    },
  );
});
