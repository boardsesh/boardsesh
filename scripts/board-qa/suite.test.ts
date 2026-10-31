import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSchema, parse, validate } from 'graphql';
import { buildSlugClimbTarget, toBoardPath } from '../../packages/mobile/src/lib/routing/board-route-target';
import { typeDefs } from '../../packages/shared-schema/src/schema';
import { Backend, type Snapshot } from './backend';
import { EXAMPLE_CONFIG, type Board, type Phone, type Role } from './config';
import type { Driver } from './drivers';
import { Evidence, QaFailure } from './evidence';
import { Fixture, type FixtureStatus } from './fixture';
import { Suite, QA_SESSION_QUEUE_QUERY, previousQueueWitness, type QaQueueSnapshot } from './suite';

const directories: string[] = [];
const roles: Role[] = ['ios', 'android'];
function phoneDriver(phone: Phone) {
  return {
    phone,
    flow: vi.fn<Driver['flow']>().mockResolvedValue(undefined),
    hierarchy: vi.fn().mockResolvedValue('app-runtime-release-test-runtime-embedded'),
    background: vi.fn().mockResolvedValue(undefined),
    foreground: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } satisfies Driver;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function soloHarness(initiallyDriving: boolean, deliverNext: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'boardsesh-qa-solo-test-'));
  directories.push(directory);
  const evidence = new Evidence(directory);
  const board: Board = {
    ...EXAMPLE_CONFIG.boards[0],
    uuid: '11111111-2222-4333-8444-555555555555',
    boardId: 123,
    layoutId: 1,
    sizeId: 1,
    setIds: '1',
    angle: 40,
    catalog: [0, 1, 2].map((index) => ({
      uuid: `climb-${index}`,
      name: `Climb ${index}`,
      frames: `p${index}r12`,
      commands: [{ position: index, r: 0, g: 252, b: 0 }],
      packetBytes: 8,
    })),
  };
  const status: FixtureStatus = {
    schemaVersion: 1,
    ok: true,
    requestId: 'test-status',
    bootId: '0123456789abcdef',
    runId: 'solo-test',
    ready: true,
    firmware: 'waveshare-amoled-gym',
    firmwareBuild: 'test-build',
    policy: 'last-connection-wins',
    leaseRemainingMs: 30_000,
    boards: [
      {
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
      },
    ],
  };
  let driving = false;
  const presence: Snapshot = { holder: null, recent: [], history: [] };
  const timeline: string[] = [];
  const phones = {
    ios: phoneDriver(EXAMPLE_CONFIG.phones.ios),
    android: phoneDriver(EXAMPLE_CONFIG.phones.android),
  };
  const backend = new Backend(EXAMPLE_CONFIG, evidence);
  backend.users.set(EXAMPLE_CONFIG.phones.ios.email, 'qa-ios');
  vi.spyOn(backend, 'snapshot').mockImplementation(async () => {
    timeline.push(`presence:${presence.recent[0]?.seq ?? 0}`);
    return structuredClone(presence);
  });
  const fixture = new Fixture('/dev/unused', 'solo-test', evidence);
  vi.spyOn(fixture, 'request').mockImplementation(async () => {
    timeline.push(`fixture:${status.boards[0].sequence}`);
    return structuredClone(status);
  });
  const deliver = (index: number, report: boolean) => {
    const current = status.boards[0];
    current.connections = 1;
    current.handles = [8];
    current.connectionHandle = 8;
    current.connectionGeneration = 1;
    current.writes++;
    current.updates++;
    current.sequence++;
    current.commands = board.catalog[index].commands;
    if (report) {
      const entry = {
        climbUuid: board.catalog[index].uuid,
        angle: board.angle,
        mirrored: false,
        sentByUserId: 'qa-ios',
        seq: (presence.recent[0]?.seq ?? 0) + 1,
        sentAt: new Date().toISOString(),
      };
      presence.holder = { userId: 'qa-ios' };
      presence.recent.unshift(entry);
      presence.history.unshift(entry);
      backend.events.push({ boardUuid: board.uuid, event: { __typename: 'BoardClimbSet', climb: entry } });
    }
  };
  const finished = new Error('Stop after the independently confirmed Next');
  phones.ios.flow.mockImplementation(async (name) => {
    timeline.push(`flow:${name}`);
    if (name === 'connect') {
      deliver(0, true);
      driving = initiallyDriving;
    } else if (name === 'drive') {
      // Production can deduplicate this same-climb history report for 10s.
      deliver(0, false);
      driving = true;
    } else if (name === 'next') {
      if (!driving) throw new Error('Next ran without driving');
      if (deliverNext) deliver(1, true);
    } else if (name === 'put') {
      deliver(0, true);
    } else if (name === 'stop-driving') throw finished;
  });
  phones.ios.hierarchy.mockImplementation(async () => `wall-control-lit-self-${driving ? 'driving' : 'idle'}`);
  return {
    suite: new Suite(EXAMPLE_CONFIG, phones, fixture, backend, [board], evidence),
    phones,
    timeline,
    finished,
    board,
    status,
    presence,
    deliver,
  };
}

describe('physical suite solo driving action order', () => {
  it.each([false, true])(
    'queues privately, reopens current, then takes a fresh Next baseline (driving=%s)',
    async (driving) => {
      vi.useFakeTimers();
      const harness = soloHarness(driving, true);
      const completed = harness.suite.solo().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(35_000);
      expect(await completed).toBe(harness.finished);
      expect(harness.phones.ios.flow.mock.calls.filter(([name]) => name !== 'assert-id').map(([name]) => name)).toEqual(
        [
          'open-climb',
          'connect',
          'open-climb',
          'queue-next',
          'return-current',
          ...(driving ? [] : ['drive']),
          'next',
          'stop-driving',
        ],
      );
      expect(harness.phones.ios.flow).toHaveBeenCalledWith('return-current', {
        CURRENT_CLIMB_UUID: harness.board.catalog[0].uuid,
        CURRENT_CLIMB_LABEL_PATTERN: '.*Climb 0.*',
      });
      const nextAt = harness.timeline.indexOf('flow:next');
      expect(harness.timeline.slice(nextAt - 2, nextAt)).toEqual([`fixture:${driving ? 1 : 2}`, 'presence:1']);
    },
  );

  it('rejects the Drive setup write when Next produces no fresh decoded delivery', async () => {
    vi.useFakeTimers();
    const harness = soloHarness(false, false);
    const completed = harness.suite.solo().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(35_000);
    expect(await completed).toBeInstanceOf(QaFailure);
    expect(((await completed) as Error).message).toContain('fresh exact decoded BLE command');
    expect(harness.phones.ios.flow.mock.calls.some(([name]) => name === 'stop-driving')).toBe(false);
  });
});

describe('iOS suspended-request recovery', () => {
  it.each([true, false])('validates a delivered pending request without another Put (picker=%s)', async (picker) => {
    const harness = soloHarness(false, false);
    harness.deliver(2, true);
    const original = { fixture: structuredClone(harness.status), presence: structuredClone(harness.presence) };
    harness.phones.ios.foreground.mockImplementation(async () => {
      harness.deliver(0, true);
    });
    await harness.suite['resumeIos'](harness.board, 'android', original, picker);
    expect(harness.phones.ios.flow.mock.calls.some(([name]) => name === 'put')).toBe(false);
    expect(harness.phones.ios.foreground).toHaveBeenCalledOnce();
    expect(harness.status.boards[0].sequence).toBe(2);
    expect(harness.presence.recent[0].climbUuid).toBe(harness.board.catalog[0].uuid);
  });

  it('requires one explicit Put after preview setup when foreground did not deliver', async () => {
    const harness = soloHarness(false, false);
    harness.deliver(2, true);
    const original = { fixture: structuredClone(harness.status), presence: structuredClone(harness.presence) };
    // An unrelated completed reassert during suspension must not become the retry baseline.
    harness.deliver(2, false);
    await harness.suite['resumeIos'](harness.board, 'android', original, true);
    expect(harness.phones.android.flow).toHaveBeenCalledWith('dismiss-picker', { BOARD_UUID: harness.board.uuid });
    expect(harness.phones.ios.flow.mock.calls.map(([name]) => name)).toEqual(['open-climb', 'put']);
    const putAt = harness.timeline.indexOf('flow:put');
    expect(harness.timeline.slice(putAt - 2, putAt)).toEqual(['fixture:2', 'presence:1']);
    expect(harness.status.boards[0].sequence).toBe(3);
  });
});

describe('notification Previous queue witness', () => {
  const previous = { uuid: 'previous-slot', climb: { uuid: 'previous-climb' } };
  const current = { uuid: 'fresh-current-slot', climb: { uuid: 'current-climb' } };
  const before: QaQueueSnapshot = { queue: [previous], currentClimbQueueItem: previous };
  const after: QaQueueSnapshot = { queue: [previous, current], currentClimbQueueItem: current };
  it('uses a read-only query supported by the production schema', () => {
    expect(validate(buildSchema(typeDefs.join('\n')), parse(QA_SESSION_QUEUE_QUERY))).toEqual([]);
  });
  it('binds both exact queue slots after a fresh trackless current commit', () => {
    expect(previousQueueWitness(before, after, 'current-climb', 'previous-climb')).toEqual({
      currentSlotUuid: current.uuid,
      previousSlotUuid: previous.uuid,
    });
  });
  it.each([
    ['orphan current', { ...after, queue: [previous] }],
    ['missing current', { ...after, currentClimbQueueItem: null }],
    ['duplicate current slot', { ...after, queue: [previous, current, current] }],
    ['duplicate predecessor slot', { ...after, queue: [previous, previous, current] }],
    ['wrong predecessor climb', { ...after, queue: [{ ...previous, climb: { uuid: 'unrelated-climb' } }, current] }],
    ['first slot', { ...after, queue: [current, previous] }],
  ] satisfies Array<[string, QaQueueSnapshot]>)('refuses %s before operating the notification', (_label, snapshot) => {
    expect(previousQueueWitness(before, snapshot, 'current-climb', 'previous-climb')).toBeNull();
  });
  it('rejects an existing Up next slot that might keep a suggestion track', () => {
    expect(
      previousQueueWitness({ ...before, queue: [previous, current] }, after, 'current-climb', 'previous-climb'),
    ).toBeNull();
  });
});

describe('physical suite named-board climb routes', () => {
  it.each(EXAMPLE_CONFIG.boards)('opens $family without redeeming a spray-wall capability', async (configured) => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(tmpdir(), 'boardsesh-qa-suite-test-'));
    directories.push(directory);
    const evidence = new Evidence(directory);
    const configuredClimb = configured.climbs[0];
    if (typeof configuredClimb === 'string') throw new Error('Expected pinned example climb UUID');
    const climb = { ...configuredClimb, frames: 'p1r12', commands: [], packetBytes: 8 };
    const board: Board = {
      ...configured,
      uuid: '11111111-2222-4333-8444-555555555555',
      boardId: 123,
      layoutId: 1,
      sizeId: 1,
      setIds: '1',
      angle: 40,
      catalog: [climb],
    };
    const idle: FixtureStatus = {
      schemaVersion: 1,
      ok: true,
      requestId: 'test-status',
      bootId: '0123456789abcdef',
      runId: '',
      ready: true,
      firmware: 'waveshare-amoled-gym',
      firmwareBuild: 'test-build',
      policy: 'concurrent',
      leaseRemainingMs: 0,
      boards: [
        {
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
          angle: board.angle,
        },
      ],
    };
    const phones = {
      ios: phoneDriver({ ...EXAMPLE_CONFIG.phones.ios, scheme: 'com.boardsesh.app' }),
      android: phoneDriver({ ...EXAMPLE_CONFIG.phones.android, scheme: 'com.boardsesh.app.dev' }),
    };
    const backend = new Backend(EXAMPLE_CONFIG, evidence);
    for (const role of roles) backend.users.set(EXAMPLE_CONFIG.phones[role].email, `qa-${role}`);
    const fixture = new Fixture('/dev/unused', 'route-test', evidence);
    vi.spyOn(fixture, 'request').mockResolvedValue(idle);
    const start = vi.spyOn(fixture, 'start').mockResolvedValue(idle);
    const suite = new Suite(EXAMPLE_CONFIG, phones, fixture, backend, [board], evidence);
    const prepared = suite.prepare();
    await vi.advanceTimersByTimeAsync(66_000);
    await prepared;

    for (const role of roles) {
      const calls = phones[role].flow.mock.calls.filter(([name]) => name === 'open-climb');
      expect(calls).toHaveLength(1);
      const variables = calls[0][1];
      const url = new URL(variables?.CLIMB_URL ?? '');
      expect(url.protocol).toBe(`${phones[role].phone.scheme}:`);
      expect(url.hostname).toBe('b');
      expect(url.search).toBe('');
      const [slug, angle, surface, segment] = url.pathname.slice(1).split('/');
      expect(surface).toBe('play');
      const target = buildSlugClimbTarget(slug, angle, segment);
      expect(target).toEqual({ kind: 'slug-climb', slug: board.slug, angle: board.angle, climbUuid: climb.uuid });
      if (!target) throw new Error('Expected a resolvable named-board target');
      expect(toBoardPath(target)).toBe(`/b/${board.slug}/${board.angle}`);
      expect(variables?.CLIMB_LABEL_PATTERN).toContain(climb.name);
    }
    expect(start).toHaveBeenCalledOnce();
  });
});
