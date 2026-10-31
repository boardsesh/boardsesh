import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Backend, Snapshot } from './backend';
import { EXAMPLE_CONFIG, type Board, type Role } from './config';
import { IosDriver, readFlow, type Driver } from './drivers';
import { selectorPredicate } from '../lib/mobile-profile-wda';
import { Evidence, QaFailure } from './evidence';
import type { Fixture, FixtureStatus } from './fixture';
import { Suite } from './suite';
import { main, PHYSICAL_SCOPES, runPhysicalScope } from '../board-qa';

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

function harness() {
  const directory = mkdtempSync(join(tmpdir(), 'boardsesh-case-boundary-'));
  directories.push(directory);
  const evidence = new Evidence(directory);
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
      packetBytes: 8,
      commands: [{ position: index * 10 + climbIndex, r: 0, g: 252, b: 0 }],
    })),
  }));
  const status: FixtureStatus = {
    schemaVersion: 1,
    ok: true,
    requestId: 'test',
    bootId: '0123456789abcdef',
    runId: 'owned-boundary-test',
    ready: true,
    firmware: 'waveshare-amoled-gym',
    firmwareBuild: 'test',
    policy: 'last-connection-wins',
    leaseRemainingMs: 30000,
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
  const snapshots: Snapshot[] = boards.map(() => ({ holder: null, recent: [], history: [] }));
  const events: Backend['events'] = [];
  const users = new Map([
    [EXAMPLE_CONFIG.phones.ios.email, 'user-ios'],
    [EXAMPLE_CONFIG.phones.android.email, 'user-android'],
  ]);
  const timeline: string[] = [];
  const fixture = {
    request: vi.fn<Fixture['request']>().mockImplementation(async () => {
      timeline.push('fixture:status');
      return structuredClone(status);
    }),
  };
  const backend = {
    users,
    events,
    snapshot: vi
      .fn<Backend['snapshot']>()
      .mockImplementation(async (board) => structuredClone(snapshots[boards.indexOf(board)])),
  };
  const selected: Record<Role, number> = { ios: 0, android: 0 };
  const source: Record<Role, number> = { ios: 0, android: 0 };
  const deliver = (role: Role) => {
    const index = selected[role];
    for (const [otherIndex, other] of status.boards.entries())
      if (otherIndex !== index) {
        other.connections = 0;
        other.handles = [];
        snapshots[otherIndex].holder = null;
      }
    const actual = status.boards[index];
    actual.connections = 1;
    actual.connectionGeneration++;
    actual.connectionHandle = actual.connectionGeneration + 7;
    actual.handles = [actual.connectionHandle];
    actual.sequence++;
    actual.writes++;
    actual.updates++;
    actual.commands = boards[index].catalog[0].commands;
    const climb = {
      climbUuid: boards[index].catalog[0].uuid,
      angle: 40,
      mirrored: false,
      sentByUserId: `user-${role}`,
      seq: (snapshots[index].recent[0]?.seq ?? 0) + 1,
      sentAt: new Date().toISOString(),
    };
    snapshots[index].holder = { userId: `user-${role}` };
    snapshots[index].recent.unshift(climb);
    snapshots[index].history.unshift(climb);
    events.push({ boardUuid: boards[index].uuid, event: { __typename: 'BoardClimbSet', climb } });
  };
  const phone = (role: Role) =>
    ({
      phone: EXAMPLE_CONFIG.phones[role],
      flow: vi.fn<Driver['flow']>().mockImplementation(async (name, variables) => {
        timeline.push(`${role}:${basename(name)}`);
        if (name === 'open-climb')
          selected[role] = boards.findIndex((board) => variables?.CLIMB_URL.includes(`/b/${board.slug}/`));
        if (name === 'connect') source[role] = selected[role];
        if (name === 'previous') selected[role] = source[role];
        if (name === 'connect' || name === 'put') deliver(role);
        if (name === 'disconnect') {
          status.boards[selected[role]].connections = 0;
          status.boards[selected[role]].handles = [];
          snapshots[selected[role]].holder = null;
        }
      }),
      hierarchy: vi.fn<Driver['hierarchy']>().mockResolvedValue(`app-runtime-release-native-${role}`),
      restart: vi.fn<Driver['restart']>().mockImplementation(async () => {
        expect(status.boards.every((board) => board.connections === 0)).toBe(true);
        timeline.push(`${role}:restart`);
      }),
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
    boards,
    evidence,
  );
  return { suite, phones, fixture, boards, status, timeline, evidence, directory };
}

describe('independent physical case boundaries', () => {
  it('runs exactly six mixed cases with both zero-link restarts before each uninterrupted three-send move', async () => {
    const current = harness();
    await current.suite.mixedBoards();
    expect(current.evidence.results.map((result) => result.name)).toEqual([
      'mixed/kilter-to-tension/ios',
      'mixed/tension-to-moonboard/ios',
      'mixed/moonboard-to-kilter/ios',
      'mixed/kilter-to-tension/android',
      'mixed/tension-to-moonboard/android',
      'mixed/moonboard-to-kilter/android',
    ]);
    expect(current.evidence.results.every((result) => result.verdict === 'passed')).toBe(true);
    expect(current.phones.ios.restart).toHaveBeenCalledTimes(6);
    expect(current.phones.android.restart).toHaveBeenCalledTimes(6);
    for (const role of ['ios', 'android'] as const)
      expect(current.phones[role].flow.mock.calls.filter(([name]) => name === 'inspect-account')).toEqual(
        Array.from({ length: 6 }, () => [
          'inspect-account',
          { ACCOUNT_URL: `${EXAMPLE_CONFIG.phones[role].scheme}://account`, USER_ID: `user-${role}` },
        ]),
      );
    const boundaries = current.timeline.reduce<number[]>((indices, step, index) => {
      if (step === 'ios:inspect-inactive-record.yaml') indices.push(index);
      return indices;
    }, []);
    for (const [caseIndex, boundary] of boundaries.entries()) {
      const steps = current.timeline.slice(boundary, boundaries[caseIndex + 1]);
      expect(steps.slice(0, 3)).toEqual([
        'ios:inspect-inactive-record.yaml',
        'android:inspect-inactive-record.yaml',
        'fixture:status',
      ]);
      for (const role of ['ios', 'android']) {
        const restarted = steps.indexOf(`${role}:restart`);
        expect(steps[restarted - 1]).toBe('fixture:status');
        expect(restarted).toBeLessThan(steps.findIndex((step) => step.endsWith(':connect')));
      }
      expect(steps.filter((step) => step.endsWith(':restart'))).toHaveLength(2);
      expect(steps.filter((step) => step.endsWith(':previous'))).toHaveLength(1);
      expect(steps.filter((step) => step.endsWith(':disconnect'))).toHaveLength(1);
    }
    const recorded = readFileSync(join(current.directory, 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string });
    expect(recorded.filter((event) => event.kind === 'confirmed-send')).toHaveLength(18);
    expect(
      readFlow(join(current.directory, 'inspect-inactive-record.yaml'), {
        APP_ID: EXAMPLE_CONFIG.phones.ios.appId,
        RECORD_URL: 'com.boardsesh.app://record',
      }),
    ).toEqual([
      { openLink: 'com.boardsesh.app://record' },
      { extendedWaitUntil: { visible: { id: 'session-start' }, timeout: 10000 } },
      { assertNotVisible: { id: 'session-active-.+' } },
    ]);
  });
  it.each(['mixedBoards', 'sessions'] as const)(
    'blocks %s before UI actions when any board is linked',
    async (scope) => {
      const current = harness();
      current.status.boards[2].connections = 1;
      await expect(current.suite[scope]()).rejects.toMatchObject({ kind: 'blocked' });
      for (const phone of Object.values(current.phones)) {
        expect(phone.flow).not.toHaveBeenCalled();
        expect(phone.restart).not.toHaveBeenCalled();
      }
    },
  );
  it.each(['ios', 'android'] as const)('requires %s Record inactive before restarting either phone', async (role) => {
    const current = harness();
    current.phones[role].flow.mockRejectedValue(new QaFailure('Retained native session'));
    await expect(current.suite.sessions()).rejects.toMatchObject({ kind: 'blocked' });
    expect(current.phones.ios.restart).not.toHaveBeenCalled();
    expect(current.phones.android.restart).not.toHaveBeenCalled();
    expect(current.evidence.results[0].verdict).toBe('blocked');
  });
  it('blocks a link that appears after both inactive Record checks, before the first restart', async () => {
    const current = harness();
    current.phones.android.flow.mockImplementation(async () => {
      current.status.boards[2].connections = 1;
    });
    await expect(current.suite.mixedBoards()).rejects.toMatchObject({ kind: 'blocked' });
    expect(current.phones.ios.restart).not.toHaveBeenCalled();
    expect(current.phones.android.restart).not.toHaveBeenCalled();
  });
  it('rechecks zero links immediately before the second restart', async () => {
    const current = harness();
    current.phones.ios.hierarchy.mockImplementation(async () => {
      current.status.boards[2].connections = 1;
      return 'app-runtime-release-native-ios';
    });
    await expect(current.suite.mixedBoards()).rejects.toMatchObject({ kind: 'blocked' });
    expect(current.phones.ios.restart).toHaveBeenCalledOnce();
    expect(current.phones.android.restart).not.toHaveBeenCalled();
  });
  it('blocks a missing configured fixture board before any restart', async () => {
    const current = harness();
    current.status.boards.pop();
    await expect(current.suite.mixedBoards()).rejects.toMatchObject({ kind: 'blocked' });
    expect(current.phones.ios.restart).not.toHaveBeenCalled();
  });
  it('requires mounted iOS navigation before sending its account route and preserves infrastructure failure', async () => {
    const current = harness();
    const cause = new QaFailure('Native readiness query timed out', 'infrastructure');
    current.phones.ios.flow.mockImplementation(async (name) => {
      if (name === 'wait-ios-app-ready') throw cause;
    });
    await expect(current.suite.mixedBoards()).rejects.toBe(cause);
    expect(current.phones.ios.flow.mock.calls.some(([name]) => name === 'inspect-account')).toBe(false);
    expect(current.phones.android.restart).not.toHaveBeenCalled();
    expect(current.evidence.results[0].verdict).toBe('infrastructure');
  });
  it('queries positive native iOS Tab Bar/Home/Climbs selectors instead of an invisible RN root identifier', async () => {
    const current = harness();
    const queried: string[] = [];
    const nativeSelectors = [
      selectorPredicate({ text: 'Tab Bar' }),
      selectorPredicate('Home'),
      selectorPredicate('Climbs'),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(url).pathname !== '/session/readiness-test/elements' || init?.method !== 'POST')
          throw new Error('Unexpected readiness request');
        if (typeof init.body !== 'string') throw new Error('Expected a literal JSON readiness request');
        const body = JSON.parse(init.body) as { using: string; value: string };
        expect(body.using).toBe('predicate string');
        queried.push(body.value);
        // Mirrors the physical contract: native controls are query-visible;
        // the plain RN root name can exist in XML yet return zero matches.
        return new Response(
          JSON.stringify({ value: nativeSelectors.includes(body.value) ? [{ ELEMENT: 'native-tab' }] : [] }),
        );
      }),
    );
    const phone = new IosDriver(EXAMPLE_CONFIG.phones.ios, current.evidence);
    phone['session'] = 'readiness-test';
    await phone.flow('wait-ios-app-ready');
    expect(queried).toEqual(nativeSelectors);
    expect(queried.every((predicate) => predicate.includes('visible == 1'))).toBe(true);
    expect(queried.some((predicate) => predicate.includes('home-screen') || predicate.includes('climbs-screen'))).toBe(
      false,
    );
  });
  it('rejects an actual runtime change after restart before any board action', async () => {
    const current = harness();
    await current.suite['identity']('ios');
    current.phones.ios.hierarchy.mockResolvedValue('app-runtime-release-different-update');
    await expect(current.suite.mixedBoards()).rejects.toMatchObject({ kind: 'blocked' });
    expect(current.phones.ios.flow.mock.calls.some(([name]) => name === 'connect')).toBe(false);
    expect(current.phones.android.restart).not.toHaveBeenCalled();
  });
  it('rejects a known active QA session even when the physical links are zero', async () => {
    const current = harness();
    current.suite['sessionId'] = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await expect(current.suite.sessions()).rejects.toMatchObject({ kind: 'blocked' });
    expect(current.phones.ios.restart).not.toHaveBeenCalled();
    expect(current.phones.android.restart).not.toHaveBeenCalled();
  });
});

describe('explicit physical CLI scopes', () => {
  it.each([
    ['mixed', ['mixed'], 6],
    ['solo', ['solo'], 12],
    ['sessions', ['sessions'], 6],
    ['all', ['solo', 'sessions'], 18],
  ] as const)('routes %s without duplicating mixed cases', async (action, expected, total) => {
    const called: string[] = [];
    await runPhysicalScope(action, {
      solo: vi.fn(async () => void called.push('solo')),
      mixedBoards: vi.fn(async () => void called.push('mixed')),
      sessions: vi.fn(async () => void called.push('sessions')),
    });
    expect(called).toEqual(expected);
    expect(PHYSICAL_SCOPES[action].total).toBe(total);
  });
  it('advertises exact scope counts without requiring any local config or devices', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main(['mixed', '--help'])).toBe(0);
    expect(output.mock.calls[0][0]).toContain('solo|mixed|sessions|all');
    expect(output.mock.calls[0][0]).toContain('mixed = 6 cross-board cases');
    expect(output.mock.calls[0][0]).toContain('all = 18 cases');
  });
});
