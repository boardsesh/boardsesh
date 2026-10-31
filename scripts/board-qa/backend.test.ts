import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { buildSchema, parse, validate } from 'graphql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { typeDefs } from '../../packages/shared-schema/src/schema';
import {
  Backend,
  decodePacket,
  parseSnapshot,
  QA_QUERIES,
  QA_SUBSCRIPTION,
  requireReadOnlyQuery,
  requireStaticFrames,
} from './backend';
import { EXAMPLE_CONFIG, type Board, type QaConfig } from './config';
import { Evidence, QaFailure } from './evidence';

const socketState = vi.hoisted(() => ({
  sent: [] as Record<string, unknown>[],
  listeners: new Map<string, Array<(...args: unknown[]) => void>>(),
  created: 0,
  acknowledge: true,
  protocolPongs: true,
  options: [] as unknown[],
  bufferedAmount: 0,
  completeSends: true,
  sendError: undefined as Error | undefined,
  completions: [] as Array<{ type: unknown; complete: (error?: Error) => void }>,
}));
vi.mock('ws', () => ({
  default: class {
    static OPEN = 1;
    readyState = 1;
    get bufferedAmount() {
      return socketState.bufferedAmount;
    }
    constructor(_url: unknown, _protocol: unknown, options: unknown) {
      socketState.created++;
      socketState.options.push(options);
      queueMicrotask(() => socketState.listeners.get('open')?.forEach((listener) => listener()));
    }
    on(event: string, listener: (...args: unknown[]) => void) {
      const listeners = socketState.listeners.get(event) ?? [];
      listeners.push(listener);
      socketState.listeners.set(event, listeners);
    }
    send(encoded: string, complete: (error?: Error) => void) {
      const message = JSON.parse(encoded) as Record<string, unknown>;
      socketState.sent.push(message);
      socketState.completions.push({ type: message.type, complete });
      if (socketState.completeSends) complete(socketState.sendError);
      if (socketState.sendError) return;
      if (message.type === 'connection_init' && socketState.acknowledge)
        queueMicrotask(() =>
          socketState.listeners
            .get('message')
            ?.forEach((listener) => listener(Buffer.from('{"type":"connection_ack"}'))),
        );
      if (message.type === 'ping' && socketState.protocolPongs)
        queueMicrotask(() =>
          socketState.listeners
            .get('message')
            ?.forEach((listener) => listener(Buffer.from(JSON.stringify({ type: 'pong', payload: message.payload })))),
        );
    }
    removeAllListeners() {
      socketState.listeners.clear();
    }
    close(code = 1000, reason = '') {
      this.readyState = 3;
      socketState.listeners.get('close')?.forEach((listener) => listener(code, Buffer.from(reason)));
    }
  },
}));

const directories: string[] = [];
function evidence(): Evidence {
  const directory = mkdtempSync(join(tmpdir(), 'board-qa-backend-'));
  directories.push(directory);
  return new Evidence(directory);
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  socketState.sent.length = 0;
  socketState.listeners.clear();
  socketState.created = 0;
  socketState.acknowledge = true;
  socketState.protocolPongs = true;
  socketState.options.length = 0;
  socketState.bufferedAmount = 0;
  socketState.completeSends = true;
  socketState.sendError = undefined;
  socketState.completions.length = 0;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const board = {
  ...EXAMPLE_CONFIG.boards[0],
  uuid: 'board-uuid',
  boardId: 1,
  layoutId: 8,
  sizeId: 25,
  setIds: '26,27,28,29',
  angle: 40,
  catalog: [],
} satisfies Board;
function wire(bytes: number[]): Uint8Array {
  return Uint8Array.from(bytes);
}
function socketEvent(event: string, ...arguments_: unknown[]): void {
  socketState.listeners.get(event)?.forEach((listener) => listener(...arguments_));
}
function socketMessage(message: Record<string, unknown>): void {
  socketEvent('message', Buffer.from(JSON.stringify(message)));
}
function lifecycleEvents(report: Evidence): Array<{ state: string; [key: string]: unknown }> {
  return readFileSync(join(report.directory, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { kind: string; payload: { state: string; [key: string]: unknown } })
    .filter((entry) => entry.kind === 'board-observer')
    .map((entry) => entry.payload);
}
const presence = {
  climbUuid: 'climb-uuid',
  angle: 40,
  mirrored: false,
  sentByUserId: 'user-id',
  seq: 12,
  sentAt: '2026-10-31T00:00:00Z',
};
const wall = { holder: { userId: 'user-id' }, recent: [presence], durable: { entries: [presence] } };

describe('independent physical packet evidence', () => {
  it('decodes literal Aurora v3 position and quantized RGB goldens', () => {
    // ONLY, positions 0x1234 and 7: red 3 bits=7, green=7, blue=3.
    expect(decodePacket(wire([1, 7, 95, 2, 84, 52, 18, 224, 7, 0, 31, 3]), false)).toEqual([
      { position: 4660, r: 252, g: 0, b: 0 },
      { position: 7, r: 0, g: 252, b: 255 },
    ]);
    expect(decodePacket(wire([1, 1, 171, 2, 84, 3]), false)).toEqual([]);
  });
  it('requires complete ordered Aurora multipart and rejects extra updates', () => {
    const first = [1, 4, 144, 2, 82, 1, 0, 28, 3];
    const last = [1, 4, 167, 2, 83, 2, 0, 3, 3];
    expect(decodePacket(wire([...first, ...last]), false)).toEqual([
      { position: 1, r: 0, g: 252, b: 0 },
      { position: 2, r: 0, g: 0, b: 255 },
    ]);
    for (const invalid of [
      [],
      first,
      last,
      [...last, ...first],
      [...first, ...first, ...last],
      [1, 1, 171, 2, 84, 3, 0],
      [1, 4, 0, 2, 84, 1, 0, 28, 3],
      [1, 1, 171, 2, 84],
    ])
      expect(() => decodePacket(wire(invalid), false)).toThrow();
  });
  it('pins MoonBoard roles and rejects unsupported config, malformed, and out-of-grid packets', () => {
    expect(decodePacket(new TextEncoder().encode('l#S0,P35,E197#'), true)).toEqual([
      { position: 0, r: 0, g: 255, b: 0 },
      { position: 35, r: 0, g: 0, b: 255 },
      { position: 197, r: 255, g: 0, b: 0 },
    ]);
    expect(decodePacket(new TextEncoder().encode('l##'), true)).toEqual([]);
    for (const invalid of ['~Dl#S1#', 'l#F1#', 'l#S198#', 'l#S1,#', 'l#S1#l#P2#', 'l#S99999999999999999999#'])
      expect(() => decodePacket(new TextEncoder().encode(invalid), true)).toThrow();
  });
  it('rejects multi-frame and permissively parseable partial climb strings', () => {
    expect(() => requireStaticFrames('p1r42p35r43p198r44', 1)).not.toThrow();
    for (const frames of ['p1r42,p2r43', 'p1r42 junk', 'p1r42p2r43p', 'p-1r42', ''])
      expect(() => requireStaticFrames(frames, 1)).toThrow();
    expect(() => requireStaticFrames('p1r42', 2)).toThrow();
  });
});

describe('production observer contracts without network access', () => {
  it('matches only the pending sequence and measures delayed pong RTT without logging arbitrary payloads', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    socketState.protocolPongs = false;
    const report = evidence();
    const backend = new Backend(EXAMPLE_CONFIG, report);
    const failed = vi.fn();
    backend.setObserverFailureHandler(failed);
    await backend.observe([board]);
    await vi.advanceTimersByTimeAsync(5_000);
    socketMessage({ type: 'pong', payload: { qaSequence: 0, untrusted: 'do-not-record-payload' } });
    await vi.advanceTimersByTimeAsync(1_234);
    socketMessage({ type: 'pong', payload: { qaSequence: 1 } });
    socketMessage({ type: 'pong', payload: { qaSequence: 1 } });
    const pongs = lifecycleEvents(report).filter((event) => event.state === 'protocol-pong-received');
    expect(pongs).toMatchObject([
      { matched: false, receivedSequence: 0, expectedSequence: 1, roundTripMs: null },
      { matched: true, receivedSequence: 1, expectedSequence: 1, roundTripMs: 1_234 },
      { matched: false, receivedSequence: 1, expectedSequence: null, roundTripMs: null },
    ]);
    await vi.advanceTimersByTimeAsync(3_766);
    socketMessage({ type: 'pong', payload: { qaSequence: '2', untrusted: 'do-not-record-payload' } });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(failed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(failed).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: expect.stringContaining('heartbeat') }),
    );
    expect(lifecycleEvents(report)).toContainEqual(
      expect.objectContaining({
        state: 'protocol-pong-timeout',
        sequence: 2,
        heartbeatAgeMs: 20_000,
        deadlineLagMs: 0,
        closeInitiator: 'heartbeat-timeout',
      }),
    );
    expect(lifecycleEvents(report)).toContainEqual(
      expect.objectContaining({ state: 'closed', closeInitiator: 'heartbeat-timeout' }),
    );
    expect(readFileSync(join(report.directory, 'events.jsonl'), 'utf8')).not.toContain('do-not-record-payload');
    expect(socketState.created).toBe(1);
    backend.close();
  });

  it('records send completion, buffering and public transport counters without network addresses', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const report = evidence();
    const backend = new Backend(EXAMPLE_CONFIG, report);
    await backend.observe([board]);
    const transport = Object.assign(new EventEmitter(), {
      bytesRead: 111,
      bytesWritten: 222,
      readableLength: 3,
      writableLength: 4,
      writableNeedDrain: true,
      destroyed: false,
      readyState: 'open',
      remoteFamily: 'IPv6',
      remoteAddress: 'private-network-address',
      localAddress: 'private-local-address',
    });
    socketEvent('upgrade', { socket: transport });
    socketState.completeSends = false;
    socketState.bufferedAmount = 128;
    await vi.advanceTimersByTimeAsync(5_000);
    const completion = socketState.completions.at(-1);
    expect(completion?.type).toBe('ping');
    expect(
      lifecycleEvents(report).filter((event) => event.state === 'send-completed' && event.messageType === 'ping'),
    ).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(321);
    completion?.complete();
    expect(lifecycleEvents(report)).toContainEqual(
      expect.objectContaining({
        state: 'send-completed',
        messageType: 'ping',
        sequence: 1,
        sendElapsedMs: 321,
        bufferedAmount: 128,
        socketReadyState: 1,
        transportBytesRead: 111,
        transportBytesWritten: 222,
        transportReadableBytes: 3,
        transportWritableBytes: 4,
        transportNeedsDrain: true,
        transportFamily: 'IPv6',
      }),
    );
    transport.emit('drain');
    transport.emit('end');
    transport.emit('close', true);
    expect(lifecycleEvents(report).map((event) => event.state)).toEqual(
      expect.arrayContaining(['transport-drain', 'transport-ended', 'transport-closed']),
    );
    const saved = readFileSync(join(report.directory, 'events.jsonl'), 'utf8');
    expect(saved).not.toContain('private-network-address');
    expect(saved).not.toContain('private-local-address');
    backend.close();
  });

  it('notifies once on send failure, redacts diagnostics and preserves that exact first failure', async () => {
    vi.useFakeTimers();
    const report = evidence();
    report.secret('private-send-token');
    const backend = new Backend(EXAMPLE_CONFIG, report);
    const failed = vi.fn();
    backend.setObserverFailureHandler(failed);
    await backend.observe([board]);
    socketState.sendError = new Error('write failed private-send-token Bearer sensitive-token');
    await vi.advanceTimersByTimeAsync(5_000);
    const firstFailure: unknown = failed.mock.calls[0]?.[0];
    expect(firstFailure).toBeInstanceOf(QaFailure);
    expect(firstFailure).toMatchObject({ message: 'Board observer socket send failed', kind: 'infrastructure' });
    socketEvent('close', 1006, Buffer.alloc(0));
    socketEvent('error', new Error('later socket error'));
    socketMessage({ type: 'error' });
    backend.setObserverFailureHandler(failed);
    await expect(backend.snapshot(board)).rejects.toBe(firstFailure);
    expect(failed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socketState.sent.filter((message) => message.type === 'ping')).toHaveLength(1);
    const saved = readFileSync(join(report.directory, 'events.jsonl'), 'utf8');
    expect(saved).toContain('send-error');
    expect(saved).not.toContain('private-send-token');
    expect(saved).not.toContain('sensitive-token');
    backend.close();
  });

  it('delivers an already latched failure once and contains asynchronous handler rejection', async () => {
    const report = evidence();
    report.secret('private-handler-token');
    const backend = new Backend(EXAMPLE_CONFIG, report);
    await backend.observe([board]);
    socketEvent('close', 1006, Buffer.alloc(0));
    const failed = vi.fn(async (_failure: QaFailure) => {
      throw new Error('handler private-handler-token');
    });
    backend.setObserverFailureHandler(failed);
    await Promise.resolve();
    await Promise.resolve();
    const replacement = vi.fn();
    backend.setObserverFailureHandler(replacement);
    socketEvent('error', new Error('second failure'));
    expect(failed).toHaveBeenCalledTimes(1);
    expect(replacement).not.toHaveBeenCalled();
    await expect(backend.snapshot(board)).rejects.toBe(failed.mock.calls[0]?.[0]);
    const saved = readFileSync(join(report.directory, 'events.jsonl'), 'utf8');
    expect(saved).toContain('board-observer-failure-handler-error');
    expect(saved).not.toContain('private-handler-token');
    expect(lifecycleEvents(report)).toContainEqual(
      expect.objectContaining({ state: 'closed', closeInitiator: 'remote' }),
    );
    backend.close();
  });

  it('contains a synchronous handler exception and ignores failures after normal teardown', async () => {
    const report = evidence();
    const backend = new Backend(EXAMPLE_CONFIG, report);
    const failed = vi.fn(() => {
      throw new Error('handler exception');
    });
    backend.setObserverFailureHandler(failed);
    await backend.observe([board]);
    socketMessage({ type: 'complete', id: board.uuid });
    expect(failed).toHaveBeenCalledTimes(1);
    await expect(backend.snapshot(board)).rejects.toMatchObject({
      message: 'Invalid or rejected board subscription evidence',
    });
    backend.close();
    expect(lifecycleEvents(report)).toContainEqual(
      expect.objectContaining({ state: 'closed', closeInitiator: 'runner' }),
    );

    // A separate normal observer has no failure to deliver, including late I/O callbacks.
    socketState.listeners.clear();
    const normal = new Backend(EXAMPLE_CONFIG, evidence());
    const normalFailed = vi.fn();
    normal.setObserverFailureHandler(normalFailed);
    await normal.observe([board]);
    normal.close();
    socketState.completions.at(-1)?.complete(new Error('late write error'));
    socketEvent('error', new Error('late socket error'));
    socketMessage({ type: 'error' });
    expect(normalFailed).not.toHaveBeenCalled();
  });

  it('routes acknowledgement timeout and malformed pre-ack evidence through the same failure callback', async () => {
    vi.useFakeTimers();
    socketState.acknowledge = false;
    const backend = new Backend(EXAMPLE_CONFIG, evidence());
    const failed = vi.fn();
    backend.setObserverFailureHandler(failed);
    const observing = backend.observe([board]);
    const assertion = expect(observing).rejects.toThrow('acknowledgement timed out');
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    expect(failed).toHaveBeenCalledTimes(1);
    backend.close();

    socketState.listeners.clear();
    const invalid = new Backend(EXAMPLE_CONFIG, evidence());
    const invalidFailed = vi.fn();
    invalid.setObserverFailureHandler(invalidFailed);
    const invalidObserving = invalid.observe([board]);
    const invalidAssertion = expect(invalidObserving).rejects.toThrow('Invalid or rejected');
    socketEvent('message', Buffer.from('not-json'));
    await invalidAssertion;
    expect(invalidFailed).toHaveBeenCalledTimes(1);
    invalid.close();
  });

  it('keeps one read-only observer alive using app-contract protocol pings and records both heartbeat layers', async () => {
    vi.useFakeTimers();
    const report = evidence();
    const backend = new Backend(EXAMPLE_CONFIG, report);
    await backend.observe([board]);
    expect(socketState.options[0]).toEqual({ autoPong: true });
    socketState.listeners.get('ping')?.forEach((listener) => listener(Buffer.from('native')));
    socketState.listeners.get('pong')?.forEach((listener) => listener(Buffer.from('native')));
    await vi.advanceTimersByTimeAsync(15_000);
    const heartbeats = socketState.sent.filter((message) => message.type === 'ping');
    expect(heartbeats).toHaveLength(3);
    expect(heartbeats[0]).toMatchObject({ payload: { qaSequence: 1 } });
    expect(
      socketState.sent.every((message) => ['connection_init', 'subscribe', 'ping'].includes(String(message.type))),
    ).toBe(true);
    expect(socketState.created).toBe(1);
    const saved = readFileSync(join(report.directory, 'events.jsonl'), 'utf8');
    expect(saved).toContain('native-ping-received');
    expect(saved).toContain('native-pong-received');
    expect(saved).toContain('protocol-pong-received');
    backend.close();
    const before = socketState.sent.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socketState.sent).toHaveLength(before);
  });

  it('retains close code/reason and timing, fails snapshots, and never reconnects over an evidence gap', async () => {
    vi.useFakeTimers();
    const report = evidence();
    report.secret('private-reason-token');
    const backend = new Backend(EXAMPLE_CONFIG, report);
    await backend.observe([board]);
    socketState.listeners
      .get('close')
      ?.forEach((listener) => listener(1012, Buffer.from('Restart private-reason-token')));
    await expect(backend.snapshot(board)).rejects.toThrow('code 1012');
    await expect(backend.observe([board])).rejects.toThrow('reconnect would hide');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socketState.created).toBe(1);
    const saved = readFileSync(join(report.directory, 'events.jsonl'), 'utf8');
    expect(saved).toContain('"code":1012');
    expect(saved).toContain('Restart [REDACTED]');
    expect(saved).not.toContain('private-reason-token');
    expect(saved).toContain('"requestedByRunner":false');
    backend.close();
  });

  it('rejects closure before acknowledgement immediately rather than losing its code to a generic timeout', async () => {
    socketState.acknowledge = false;
    const backend = new Backend(EXAMPLE_CONFIG, evidence());
    const observing = backend.observe([board]);
    const failure = expect(observing).rejects.toThrow('code 4403');
    socketState.listeners.get('close')?.forEach((listener) => listener(4403, Buffer.from('Forbidden')));
    await failure;
    backend.close();
  });

  it('fails closed when the observer dies during an in-flight HTTP snapshot', async () => {
    const backend = new Backend(EXAMPLE_CONFIG, evidence());
    await backend.observe([board]);
    let finishQuery: (result: Record<string, unknown>) => void = () => {};
    vi.spyOn(backend, 'query').mockImplementation(
      () =>
        new Promise((resolveQuery) => {
          finishQuery = resolveQuery;
        }),
    );
    const reading = backend.snapshot(board);
    const failure = expect(reading).rejects.toThrow('code 1006');
    socketState.listeners.get('close')?.forEach((listener) => listener(1006, Buffer.alloc(0)));
    finishQuery(wall);
    await failure;
    backend.close();
  });

  it('cancels a pending acknowledgement on teardown and ignores a delayed acknowledgement', async () => {
    vi.useFakeTimers();
    socketState.acknowledge = false;
    const backend = new Backend(EXAMPLE_CONFIG, evidence());
    const observing = backend.observe([board]);
    const failure = expect(observing).rejects.toThrow('closed before acknowledgement');
    backend.close();
    await failure;
    const before = socketState.sent.length;
    socketState.listeners.get('message')?.forEach((listener) => listener(Buffer.from('{"type":"connection_ack"}')));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socketState.sent).toHaveLength(before);
  });

  it('answers server protocol pings and fails a missing matching heartbeat response without retrying', async () => {
    vi.useFakeTimers();
    const report = evidence();
    const backend = new Backend(EXAMPLE_CONFIG, report);
    await backend.observe([board]);
    socketState.listeners
      .get('message')
      ?.forEach((listener) => listener(Buffer.from('{"type":"ping","payload":{"probe":1}}')));
    expect(socketState.sent.at(-1)).toEqual({ type: 'pong', payload: { probe: 1 } });
    socketState.protocolPongs = false;
    await vi.advanceTimersByTimeAsync(25_000);
    await expect(backend.snapshot(board)).rejects.toThrow('heartbeat response timed out');
    expect(socketState.sent.filter((message) => message.type === 'ping')).toHaveLength(1);
    expect(socketState.created).toBe(1);
    const saved = readFileSync(join(report.directory, 'events.jsonl'), 'utf8');
    expect(saved).toContain('protocol-pong-timeout');
    backend.close();
  });

  it('fetches pinned UUIDs directly and never selects a namesake from search', async () => {
    const fixtures = [
      { name: 'Same name', uuid: 'first' },
      { name: 'Second', uuid: 'second' },
      { name: 'Third', uuid: 'third' },
    ];
    const config: QaConfig = { ...EXAMPLE_CONFIG, boards: [{ ...EXAMPLE_CONFIG.boards[2], climbs: fixtures }] };
    const backend = new Backend(config, evidence());
    const query = vi.spyOn(backend, 'query').mockImplementation(async (document, variables) => {
      if (document === QA_QUERIES.board)
        return {
          boardBySlug: {
            uuid: 'moon-wall',
            boardId: 3,
            boardType: 'moonboard',
            gymUuid: 'ef8b823e-8d2e-4840-8218-761369f9c059',
            layoutId: 3,
            sizeId: 1,
            setIds: '5,6,7,8,9,10',
            angle: 40,
          },
        };
      if (document !== QA_QUERIES.climb) throw new Error('Pinned catalog must not search by name');
      const index = fixtures.findIndex((fixture) => fixture.uuid === variables?.climbUuid);
      return { climb: { ...fixtures[index], frames: `p${index + 1}r42`, framesCount: 1 } };
    });
    const catalog = await backend.catalog();
    expect(catalog[0].catalog.map((climb) => climb.uuid)).toEqual(['first', 'second', 'third']);
    expect(query).toHaveBeenCalledTimes(4);
  });
  it('refuses ambiguous name-only candidates and wrong-UUID responses', async () => {
    const named: QaConfig = { ...EXAMPLE_CONFIG, boards: [{ ...EXAMPLE_CONFIG.boards[2], climbs: ['Same name'] }] };
    const backend = new Backend(named, evidence());
    const query = vi.spyOn(backend, 'query').mockImplementation(async (document) =>
      document === QA_QUERIES.board
        ? {
            boardBySlug: {
              uuid: 'moon-wall',
              boardId: 3,
              boardType: 'moonboard',
              gymUuid: 'ef8b823e-8d2e-4840-8218-761369f9c059',
              layoutId: 3,
              sizeId: 1,
              setIds: '5,6,7,8,9,10',
              angle: 40,
            },
          }
        : {
            searchClimbs: {
              climbs: [
                { uuid: 'a', name: 'Same name', frames: 'p1r42', framesCount: 1 },
                { uuid: 'b', name: 'same NAME', frames: 'p2r42', framesCount: 1 },
              ],
            },
          },
    );
    await expect(backend.catalog()).rejects.toThrow('Ambiguous');
    named.boards[0].climbs = [{ name: 'Same name', uuid: 'wanted' }];
    query
      .mockResolvedValueOnce({
        boardBySlug: {
          uuid: 'moon-wall',
          boardId: 3,
          boardType: 'moonboard',
          gymUuid: 'ef8b823e-8d2e-4840-8218-761369f9c059',
          layoutId: 3,
          sizeId: 1,
          setIds: '5,6,7,8,9,10',
          angle: 40,
        },
      })
      .mockResolvedValueOnce({ climb: { uuid: 'wrong', name: 'Same name', frames: 'p1r42', framesCount: 1 } });
    await expect(backend.catalog()).rejects.toThrow('missing');
  });

  it('validates every observer document against the repository schema', () => {
    const schema = buildSchema(typeDefs.join('\n'));
    for (const query of [...Object.values(QA_QUERIES), QA_SUBSCRIPTION])
      expect(validate(schema, parse(query))).toEqual([]);
  });
  it('rejects mutations even when hidden after a leading query', () => {
    for (const query of [
      'mutation { endSession(sessionId: "x") }',
      'query Good { profile { id } } mutation Bad { endSession(sessionId: "x") }',
      'query A { profile { id } } query B { profile { id } }',
    ])
      expect(() => requireReadOnlyQuery(query)).toThrow();
    expect(() => requireReadOnlyQuery('# read only\n query { profile { id } }')).not.toThrow();
  });
  it('rejects invalid presence shapes and preserves anonymous/null states', () => {
    expect(parseSnapshot(wall)).toEqual({ holder: wall.holder, recent: [presence], history: [presence] });
    expect(
      parseSnapshot({
        holder: { userId: null },
        recent: [{ ...presence, angle: null, mirrored: null, sentByUserId: null }],
        durable: { entries: [] },
      }).holder,
    ).toEqual({ userId: null });
    for (const seq of [NaN, -1, 0, 1.5, '12'])
      expect(() => parseSnapshot({ ...wall, recent: [{ ...presence, seq }] })).toThrow();
    expect(() => parseSnapshot({ ...wall, recent: null })).toThrow();
    expect(() => parseSnapshot({ ...wall, durable: {} })).toThrow();
  });
  it('authenticates the observer using the backend authToken contract and redacts secrets', async () => {
    const report = evidence();
    const requests: Array<{ url: string; body: Record<string, unknown>; authorization: string | undefined }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL | string, options: RequestInit) => {
        if (typeof options.body !== 'string') throw new Error('Expected JSON body');
        const body = JSON.parse(options.body) as Record<string, unknown>;
        requests.push({
          url: String(url),
          body,
          authorization: (options.headers as Record<string, string>).Authorization,
        });
        return new Response(
          JSON.stringify(
            String(url).endsWith('/auth/native/credentials')
              ? { jwt: 'private-test-token' }
              : { data: { profile: { id: 'user-id' } } },
          ),
          { status: 200 },
        );
      }),
    );
    const backend = new Backend(EXAMPLE_CONFIG, report);
    await backend.signIn(EXAMPLE_CONFIG.phones.ios.email, 'private-test-password');
    await backend.observe([board]);
    expect(requests[0]).toMatchObject({
      url: 'https://ws.boardsesh.com/auth/native/credentials',
      body: { email: EXAMPLE_CONFIG.phones.ios.email, password: 'private-test-password' },
    });
    expect(requests[1].authorization).toBe('Bearer private-test-token');
    expect(socketState.sent[0]).toMatchObject({
      type: 'connection_init',
      payload: { authToken: 'private-test-token' },
    });
    expect(socketState.sent[1]).toMatchObject({
      id: board.uuid,
      type: 'subscribe',
      payload: { query: QA_SUBSCRIPTION, variables: { boardId: board.boardId, boardUuid: board.uuid } },
    });
    report.event('secret-redaction-check', { token: 'private-test-token', password: 'private-test-password' });
    const saved = readFileSync(join(report.directory, 'events.jsonl'), 'utf8');
    expect(saved).not.toContain('private-test-token');
    expect(saved).not.toContain('private-test-password');
    backend.close();
  });
});
