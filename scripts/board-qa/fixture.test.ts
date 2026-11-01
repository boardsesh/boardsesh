import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Evidence } from './evidence';
import { Fixture, parseStatus, type FixtureRequest, type FixtureStatus, type FixtureTransport } from './fixture';

const BOARD_UUID = 'cd558849-aaf1-4e24-bce5-4a6b22129d49';
const request: FixtureRequest = { action: 'status', requestId: 'poll-1', runId: 'test-run' };
function status(selected: FixtureRequest = request): FixtureStatus {
  const runId = selected.action === 'end' ? '' : (selected.runId ?? '');
  return {
    schemaVersion: 1,
    requestId: selected.requestId,
    ok: true,
    bootId: '0123456789abcdef',
    firmware: 'waveshare-amoled-gym',
    firmwareBuild: 'Oct 31 2026 10:00:00',
    ready: true,
    runId,
    policy: runId ? 'last-connection-wins' : 'concurrent',
    leaseRemainingMs: runId ? 30_000 : 0,
    boards: [
      {
        uuid: BOARD_UUID,
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
}
class FakeTransport implements FixtureTransport {
  receive: (line: string) => void = () => undefined;
  failed: (error: Error) => void = () => undefined;
  readonly writes: FixtureRequest[] = [];
  autoReply = true;
  closed = false;
  async open(receive: (line: string) => void, failed: (error: Error) => void): Promise<void> {
    this.receive = receive;
    this.failed = failed;
  }
  write(selected: FixtureRequest): void {
    this.writes.push(selected);
    if (this.autoReply) queueMicrotask(() => this.respond(selected));
  }
  respond(selected = this.writes.at(-1), overrides: Record<string, unknown> = {}): void {
    if (!selected) throw new Error('No pending fake request');
    this.receive(JSON.stringify({ ...status(selected), ...overrides }));
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}
const directories: string[] = [];
function harness(): { fixture: Fixture; transport: FakeTransport } {
  const directory = mkdtempSync(join(tmpdir(), 'boardsesh-fixture-client-'));
  directories.push(directory);
  const transport = new FakeTransport();
  return { transport, fixture: new Fixture('/dev/unused', 'test-run', new Evidence(directory), { transport }) };
}
afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('physical fixture evidence validation', () => {
  it('accepts owner status, complete clear payloads, and non-acquiring doctor reads', () => {
    expect(parseStatus(status(), { request }).policy).toBe('last-connection-wins');
    const observe: FixtureRequest = { action: 'status', requestId: 'observe' };
    expect(parseStatus(status(observe), { request: observe }).runId).toBe('');
    expect(parseStatus({ ...status(), requestId: observe.requestId }, { request: observe }).runId).toBe('test-run');
    const completed = status();
    Object.assign(completed.boards[0], {
      updates: 1,
      writes: 3,
      sequence: 1,
      connectionHandle: 8,
      connectionGeneration: 1,
    });
    expect(parseStatus(completed, { request }).boards[0].commands).toEqual([]);
  });

  it.each([
    ['schema', { schemaVersion: 2 }],
    ['request ID', { requestId: 'other' }],
    ['success', { ok: 'true' }],
    ['firmware', { firmware: 'waveshare-amoled-216' }],
    ['build', { firmwareBuild: '' }],
    ['boot', { bootId: 'unknown' }],
    ['ready', { ready: 'yes' }],
    ['policy', { policy: 'concurrent' }],
    ['lease', { leaseRemainingMs: 0 }],
    ['long lease', { leaseRemainingMs: 30_001 }],
    ['inventory', { boards: [] }],
  ])('rejects invalid %s metadata', (_name, overrides) => {
    expect(() => parseStatus({ ...status(), ...overrides }, { request })).toThrow();
  });

  it('rejects unavailable radio, foreign ownership, reboot, and unreleased ownership', () => {
    expect(() => parseStatus({ ...status(), ready: false }, { request })).toThrow('not ready');
    expect(() => parseStatus({ ...status(), runId: 'other-run' }, { request })).toThrow('ownership');
    expect(() => parseStatus(status(), { request, bootId: '1111111111111111' })).toThrow('rebooted');
    expect(() => parseStatus(status(), { request: { ...request, action: 'end' } })).toThrow('not released');
    expect(() => parseStatus({ ...status(), ok: false, error: 'Fixture is busy' }, { request })).toThrow('busy');
  });

  const badBoards: Array<[string, Record<string, unknown>]> = [
    ['negative counter', { writes: -1 }],
    ['fractional counter', { updates: 1.5 }],
    ['unsafe counter', { writes: Number.MAX_SAFE_INTEGER + 1 }],
    ['missing counter', { rejected: undefined }],
    ['UUID', { uuid: 'board-one' }],
    ['handles', { connections: 1, handles: [] }],
    ['repeated handles', { connections: 2, handles: [1, 1] }],
    ['reserved handle', { connections: 1, handles: [65535] }],
    ['phantom sequence', { sequence: 1 }],
    ['phantom payload', { commands: [{ position: 1, r: 0, g: 0, b: 0 }] }],
    [
      'LED channel',
      {
        updates: 1,
        sequence: 1,
        connectionHandle: 1,
        connectionGeneration: 1,
        commands: [{ position: 0, r: 256, g: 0, b: 0 }],
      },
    ],
    [
      'missing LED channel',
      {
        updates: 1,
        sequence: 1,
        connectionHandle: 1,
        connectionGeneration: 1,
        commands: [{ position: 0, r: 0, b: 0 }],
      },
    ],
    ['angle', { angle: 91 }],
  ];
  it.each(badBoards)('rejects invalid %s board evidence', (_name, overrides) => {
    const candidate = status();
    expect(() =>
      parseStatus({ ...candidate, boards: [{ ...candidate.boards[0], ...overrides }] }, { request }),
    ).toThrow();
  });

  it('rejects duplicate identities and handles shared across boards', () => {
    const candidate = status();
    expect(() =>
      parseStatus({ ...candidate, boards: [candidate.boards[0], candidate.boards[0]] }, { request }),
    ).toThrow('duplicate');
    const first = { ...candidate.boards[0], handles: [1], connections: 1 };
    const second = { ...first, uuid: '803099ab-30ae-45e4-82e3-6bb2744af255' };
    expect(() => parseStatus({ ...candidate, boards: [first, second] }, { request })).toThrow('handles');
  });

  it('requires monotonic counters and payload changes tied to completed updates', () => {
    const previous = status();
    Object.assign(previous.boards[0], {
      updates: 1,
      writes: 2,
      sequence: 3,
      connectionHandle: 1,
      connectionGeneration: 2,
      commands: [{ position: 1, r: 255, g: 0, b: 0 }],
    });
    const backwards = structuredClone(previous);
    backwards.boards[0].writes = 1;
    expect(() => parseStatus(backwards, { request, previous })).toThrow('backwards');
    const changed = structuredClone(previous);
    changed.boards[0].commands[0].position = 2;
    expect(() => parseStatus(changed, { request, previous })).toThrow('without a completed-update');
    changed.boards[0].updates = 2;
    expect(() => parseStatus(changed, { request, previous })).toThrow('did not advance');
    changed.boards[0].sequence = 4;
    expect(parseStatus(changed, { request, previous }).boards[0].commands[0].position).toBe(2);
  });
});

describe('single-owner USB request coordination', () => {
  it('coalesces concurrent status reads and does not send a doctor runId', async () => {
    const { fixture, transport } = harness();
    await fixture.open();
    transport.autoReply = false;
    const first = fixture.request('status', undefined, true);
    const second = fixture.request('status', undefined, true);
    expect(first).toBe(second);
    await vi.waitFor(() => expect(transport.writes).toHaveLength(1));
    expect(transport.writes[0]).not.toHaveProperty('runId');
    transport.respond();
    await first;
    await fixture.close();
    expect(transport.closed).toBe(true);
    expect(transport.writes.map((entry) => entry.action)).toEqual(['status']);
  });

  it('serializes mutations behind a full snapshot instead of overlapping USB output', async () => {
    const { fixture, transport } = harness();
    await fixture.open();
    await fixture.start();
    transport.autoReply = false;
    const reading = fixture.request('status');
    const dropping = fixture.request('drop', BOARD_UUID);
    await vi.waitFor(() => expect(transport.writes).toHaveLength(2));
    expect(transport.writes.at(-1)?.action).toBe('status');
    transport.respond();
    await reading;
    await vi.waitFor(() => expect(transport.writes).toHaveLength(3));
    expect(transport.writes.at(-1)?.action).toBe('drop');
    transport.respond();
    await dropping;
    transport.autoReply = true;
    await fixture.close();
    expect(transport.writes.at(-1)?.action).toBe('end');
  });

  it('coalesces heartbeat with UI polling and schedules the next heartbeat after completion', async () => {
    vi.useFakeTimers();
    const { fixture, transport } = harness();
    await fixture.open();
    await fixture.start();
    transport.autoReply = false;
    const reading = fixture.request('status');
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport.writes.map((entry) => entry.action)).toEqual(['start', 'status']);
    transport.respond();
    await reading;
    await vi.advanceTimersByTimeAsync(4999);
    expect(transport.writes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.writes).toHaveLength(3);
    transport.respond();
    await Promise.resolve();
    transport.autoReply = true;
    await fixture.close();
  });

  it('waits the bounded 20-second deadline and ignores a late reply', async () => {
    vi.useFakeTimers();
    const { fixture, transport } = harness();
    await fixture.open();
    transport.autoReply = false;
    const reading = fixture.request('status', undefined, true);
    const assertion = expect(reading).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(19_999);
    expect(transport.writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    transport.respond();
    await fixture.close();
  });

  it('reports malformed telemetry immediately and still attempts owner release', async () => {
    const { fixture, transport } = harness();
    await fixture.open();
    await fixture.start();
    transport.autoReply = false;
    const reading = fixture.request('status');
    const assertion = expect(reading).rejects.toThrow('Malformed tagged');
    await vi.waitFor(() => expect(transport.writes).toHaveLength(2));
    transport.receive('{broken');
    await assertion;
    transport.autoReply = true;
    await fixture.close();
    expect(transport.writes.at(-1)?.action).toBe('end');
  });
});
