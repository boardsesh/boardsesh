import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { runAuthDrop, waitForEnter } from '../board-qa-auth-drop';
import { Evidence } from './evidence';
import type { AuthDropResult, Fixture, FixtureStatus } from './fixture';

const BOARD_UUID = '803099ab-30ae-45e4-82e3-6bb2744af255';
const directories: string[] = [];
function harness() {
  const directory = mkdtempSync(join(tmpdir(), 'boardsesh-auth-drop-'));
  directories.push(directory);
  const snapshot: FixtureStatus = {
    schemaVersion: 1,
    ok: true,
    requestId: 'status',
    bootId: '0123456789abcdef',
    runId: '',
    ready: true,
    firmware: 'waveshare-amoled-gym',
    firmwareBuild: 'test',
    policy: 'concurrent',
    leaseRemainingMs: 0,
    boards: [
      {
        uuid: BOARD_UUID,
        connections: 0,
        handles: [],
        activeConnections: [],
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
  const result: AuthDropResult = {
    connectionHandle: 8,
    connectionGeneration: 19,
    reason: 5,
    attempted: true,
    gapReturnCode: 0,
    commandAccepted: true,
  };
  const fixture = {
    open: vi.fn<Fixture['open']>().mockResolvedValue(undefined),
    request: vi.fn<Fixture['request']>().mockResolvedValue(snapshot),
    start: vi.fn<Fixture['start']>().mockResolvedValue(snapshot),
    authDrop: vi.fn<Fixture['authDrop']>().mockResolvedValue(result),
    close: vi.fn<Fixture['close']>().mockResolvedValue(undefined),
  };
  return { fixture, snapshot, result, evidence: new Evidence(directory), directory };
}
afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('auth-drop operator flow', () => {
  it('leases before inviting a phone, waits for confirmation, sends once and records command-only evidence', async () => {
    const current = harness();
    const log = vi.fn();
    const confirm = vi.fn(async () => {
      expect(current.fixture.start).toHaveBeenCalledOnce();
      expect(current.fixture.authDrop).not.toHaveBeenCalled();
    });
    await runAuthDrop(current.fixture, BOARD_UUID, current.evidence, confirm, log);
    expect(current.fixture.authDrop).toHaveBeenCalledExactlyOnceWith(BOARD_UUID);
    expect(current.fixture.close).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(join(current.directory, 'auth-drop.json'), 'utf8'))).toMatchObject({
      commandAccepted: true,
      phoneOutcome: 'not-observed',
    });
    expect(log.mock.calls.at(-1)?.[0]).toContain('Android status and app UI remain unverified');
  });

  it.each(['busy', 'old-firmware', 'wrong-board'] as const)(
    'refuses %s before acquiring firmware ownership',
    async (failure) => {
      const current = harness();
      if (failure === 'busy') current.snapshot.boards[0].connections = 1;
      if (failure === 'old-firmware') delete current.snapshot.boards[0].activeConnections;
      if (failure === 'wrong-board') current.snapshot.boards = [];
      const confirm = vi.fn();
      await expect(runAuthDrop(current.fixture, BOARD_UUID, current.evidence, confirm, vi.fn())).rejects.toThrow();
      expect(current.fixture.start).not.toHaveBeenCalled();
      expect(current.fixture.authDrop).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      expect(current.fixture.close).toHaveBeenCalledOnce();
    },
  );

  it('closes owned resources when confirmation is interrupted and never sends a drop', async () => {
    const current = harness();
    await expect(
      runAuthDrop(
        current.fixture,
        BOARD_UUID,
        current.evidence,
        async () => {
          throw new Error('interrupted');
        },
        vi.fn(),
      ),
    ).rejects.toThrow('interrupted');
    expect(current.fixture.authDrop).not.toHaveBeenCalled();
    expect(current.fixture.close).toHaveBeenCalledOnce();
  });

  it('waits for Enter and stops on interruption or the bounded deadline', async () => {
    vi.useFakeTimers();
    const input = new PassThrough();
    const controller = new AbortController();
    const confirmed = waitForEnter(controller.signal, input);
    input.write('\n');
    await confirmed;
    const interrupted = waitForEnter(controller.signal, new PassThrough());
    const interruptedAssertion = expect(interrupted).rejects.toThrow('interrupted');
    controller.abort();
    await interruptedAssertion;
    const expired = waitForEnter(new AbortController().signal, new PassThrough());
    const expiredAssertion = expect(expired).rejects.toThrow('300 seconds');
    await vi.advanceTimersByTimeAsync(300_000);
    await expiredAssertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});
