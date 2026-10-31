import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSlugClimbTarget, toBoardPath } from '../../packages/mobile/src/lib/routing/board-route-target';
import { Backend } from './backend';
import { EXAMPLE_CONFIG, type Board, type Phone, type Role } from './config';
import type { Driver } from './drivers';
import { Evidence } from './evidence';
import { Fixture, type FixtureStatus } from './fixture';
import { Suite } from './suite';

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
