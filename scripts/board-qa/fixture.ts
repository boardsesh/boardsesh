import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Led } from './config';
import { record } from './config';
import { Evidence, QaFailure } from './evidence';

export type FixtureBoard = {
  uuid: string;
  connections: number;
  handles: number[];
  writes: number;
  updates: number;
  rejected: number;
  sequence: number;
  connectionHandle: number;
  connectionGeneration: number;
  commands: Led[];
  angle: number;
};
export type FixtureStatus = {
  schemaVersion: 1;
  ok: true;
  requestId: string;
  bootId: string;
  runId: string;
  ready: boolean;
  firmware: 'waveshare-amoled-gym';
  firmwareBuild: string;
  policy: 'concurrent' | 'last-connection-wins';
  leaseRemainingMs: number;
  boards: FixtureBoard[];
};
type Action = 'start' | 'status' | 'drop' | 'end';
export type FixtureRequest = { action: Action; requestId: string; runId?: string; boardUuid?: string };
export interface FixtureTransport {
  open(receive: (line: string) => void, failed: (error: Error) => void): Promise<void>;
  write(request: FixtureRequest): void;
  close(): Promise<void>;
}
type ExpectedReply = { request: FixtureRequest; bootId?: string; previous?: FixtureStatus };
const RUN_ID = /^[a-zA-Z0-9_-]{1,80}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function malformed(message: string): never {
  throw new QaFailure(`Invalid fixture QA evidence: ${message}`, 'infrastructure');
}
function integer(candidate: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 0 || candidate > maximum)
    return malformed(label);
  return candidate;
}
function textField(candidate: unknown, label: string, maximum: number): string {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > maximum) return malformed(label);
  return candidate;
}
function object(candidate: unknown, label: string): Record<string, unknown> {
  try {
    return record(candidate);
  } catch {
    return malformed(label);
  }
}
function decodedCommand(candidate: unknown): Led {
  const command = object(candidate, 'decoded command');
  return {
    position: integer(command.position, 'LED position', 65535),
    r: integer(command.r, 'red channel', 255),
    g: integer(command.g, 'green channel', 255),
    b: integer(command.b, 'blue channel', 255),
  };
}
function parseBoard(candidate: unknown): FixtureBoard {
  const board = object(candidate, 'board');
  const uuid = textField(board.uuid, 'board UUID', 36);
  if (!UUID.test(uuid)) malformed('board UUID');
  if (!Array.isArray(board.handles) || board.handles.length > 3) malformed('connection handles');
  const handles = board.handles.map((handle: unknown) => integer(handle, 'connection handle', 65534));
  const connections = integer(board.connections, 'connection count', 3);
  if (handles.length !== connections || new Set(handles).size !== handles.length)
    malformed('connection/handle mismatch');
  if (!Array.isArray(board.commands) || board.commands.length > 1024) malformed('decoded command count');
  const parsed: FixtureBoard = {
    uuid,
    handles,
    connections,
    writes: integer(board.writes, 'write counter'),
    updates: integer(board.updates, 'completed-update counter'),
    rejected: integer(board.rejected, 'rejected-packet counter'),
    sequence: integer(board.sequence, 'completed sequence'),
    connectionHandle: integer(board.connectionHandle, 'completed writer handle', 65535),
    connectionGeneration: integer(board.connectionGeneration, 'completed writer generation'),
    angle: integer(board.angle, 'board angle', 90),
    commands: board.commands.map(decodedCommand),
  };
  if (parsed.updates === 0) {
    if (
      parsed.sequence !== 0 ||
      parsed.connectionGeneration !== 0 ||
      parsed.connectionHandle !== 65535 ||
      parsed.commands.length
    )
      malformed('payload without a completed update');
  } else if (
    parsed.sequence < parsed.updates ||
    parsed.connectionGeneration === 0 ||
    parsed.connectionHandle === 65535
  ) {
    malformed('missing completed-writer evidence');
  }
  return parsed;
}

/** No cast can turn incomplete USB telemetry into passing physical evidence. */
export function parseStatus(candidate: unknown, expected: ExpectedReply): FixtureStatus {
  const reply = object(candidate, 'reply');
  if (reply.schemaVersion !== 1 || reply.requestId !== expected.request.requestId) malformed('schema or request ID');
  if (reply.ok === false)
    throw new QaFailure(`Fixture QA request rejected: ${textField(reply.error, 'rejection reason', 256)}`, 'blocked');
  if (reply.ok !== true) malformed('success flag');
  if (reply.firmware !== 'waveshare-amoled-gym') malformed('unexpected firmware target');
  const bootId = textField(reply.bootId, 'boot identity', 16);
  if (!/^[0-9a-f]{16}$/i.test(bootId)) malformed('boot identity');
  if (expected.bootId && bootId !== expected.bootId)
    throw new QaFailure('ESP32 rebooted during the test', 'infrastructure');
  const firmwareBuild = textField(reply.firmwareBuild, 'firmware build identity', 128);
  if (typeof reply.runId !== 'string' || (reply.runId !== '' && !RUN_ID.test(reply.runId))) malformed('run ID');
  const runId = reply.runId;
  if (typeof reply.ready !== 'boolean') malformed('ready flag');
  const leaseRemainingMs = integer(reply.leaseRemainingMs, 'lease duration', 30_000);
  const policy = reply.policy;
  if (policy !== 'concurrent' && policy !== 'last-connection-wins') malformed('connection policy');
  if (policy !== (runId ? 'last-connection-wins' : 'concurrent') || Boolean(runId) !== leaseRemainingMs > 0)
    malformed('ownership/policy/lease mismatch');
  const { request } = expected;
  if (request.action === 'end') {
    if (runId || policy !== 'concurrent') malformed('QA ownership was not released');
  } else if (request.runId && (runId !== request.runId || policy !== 'last-connection-wins')) {
    throw new QaFailure('Fixture QA ownership changed or expired', 'infrastructure');
  }
  if (!reply.ready && request.action !== 'end') throw new QaFailure('Fixture radio is not ready', 'blocked');
  if (!Array.isArray(reply.boards) || reply.boards.length < 1 || reply.boards.length > 3) malformed('board inventory');
  const boards = reply.boards.map(parseBoard);
  if (new Set(boards.map((board) => board.uuid)).size !== boards.length) malformed('duplicate board UUID');
  const handles = boards.flatMap((board) => board.handles);
  if (new Set(handles).size !== handles.length || handles.length > 3) malformed('shared or excessive radio handles');
  if (expected.previous) {
    const previous = expected.previous;
    if (previous.firmwareBuild !== firmwareBuild) malformed('firmware build changed without a new boot ID');
    if (boards.length !== previous.boards.length) malformed('board inventory changed');
    for (const board of boards) {
      const earlier = previous.boards.find((entry) => entry.uuid === board.uuid);
      if (!earlier) malformed('board inventory changed');
      if (
        board.writes < earlier.writes ||
        board.updates < earlier.updates ||
        board.rejected < earlier.rejected ||
        board.sequence < earlier.sequence ||
        board.connectionGeneration < earlier.connectionGeneration
      )
        malformed('counter or writer generation went backwards');
      if (
        board.updates === earlier.updates &&
        (board.sequence !== earlier.sequence ||
          board.connectionGeneration !== earlier.connectionGeneration ||
          board.connectionHandle !== earlier.connectionHandle ||
          JSON.stringify(board.commands) !== JSON.stringify(earlier.commands))
      )
        malformed('completed payload changed without a completed-update increment');
      if (board.updates > earlier.updates && board.sequence <= earlier.sequence)
        malformed('completed sequence did not advance');
    }
  }
  return {
    schemaVersion: 1,
    ok: true,
    requestId: request.requestId,
    bootId,
    runId,
    ready: reply.ready,
    firmware: reply.firmware,
    firmwareBuild,
    policy,
    leaseRemainingMs,
    boards,
  };
}

class SerialTransport implements FixtureTransport {
  private child?: ChildProcessWithoutNullStreams;
  private closing = false;
  constructor(
    private port: string,
    private evidence: Evidence,
  ) {}
  async open(receive: (line: string) => void, failed: (error: Error) => void): Promise<void> {
    const child = spawn(
      'uv',
      ['run', '--script', fileURLToPath(new URL('./usb-serial.py', import.meta.url)), '--port', this.port],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.child = child;
    await new Promise<void>((resolveReady, reject) => {
      const fail = (message: string) => {
        if (this.closing) return;
        clearTimeout(timer);
        const error = new QaFailure(message, 'infrastructure');
        failed(error);
        reject(error);
      };
      const timer = setTimeout(() => fail('USB transport did not open; check pyserial and serial ownership'), 30_000);
      child.on('error', () => fail('Cannot start USB transport (uv)'));
      child.on('exit', () => fail('USB transport exited'));
      child.stderr.on('data', (chunk: Buffer) => this.evidence.event('serial-transport', chunk.toString()));
      createInterface({ input: child.stdout }).on('line', (line) => {
        try {
          if (object(JSON.parse(line) as unknown, 'transport message').transportReady === true) {
            clearTimeout(timer);
            resolveReady();
            return;
          }
        } catch {
          /* The reply parser reports malformed tagged telemetry. */
        }
        receive(line);
      });
    });
  }
  write(request: FixtureRequest): void {
    if (!this.child || !this.child.stdin.writable)
      throw new QaFailure('USB transport is not writable', 'infrastructure');
    this.child.stdin.write(JSON.stringify(request) + '\n');
  }
  async close(): Promise<void> {
    this.closing = true;
    this.child?.stdin.end();
    this.child?.kill('SIGTERM');
    this.child = undefined;
  }
}

export class Fixture {
  private readonly transport: FixtureTransport;
  private readonly pending = new Map<
    string,
    {
      request: FixtureRequest;
      resolve: (snapshot: FixtureStatus) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private heartbeat?: ReturnType<typeof setTimeout>;
  private failure?: Error;
  private owned = false;
  private opened = false;
  private closing = false;
  private latest?: FixtureStatus;
  private tail: Promise<void> = Promise.resolve();
  private readonly statusRequests = new Map<string, Promise<FixtureStatus>>();
  private readonly replyTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  constructor(
    port: string,
    readonly runId: string,
    private evidence: Evidence,
    options: { transport?: FixtureTransport; replyTimeoutMs?: number; heartbeatIntervalMs?: number } = {},
  ) {
    if (!RUN_ID.test(runId)) throw new Error('Invalid fixture QA run ID');
    this.transport = options.transport ?? new SerialTransport(port, evidence);
    this.replyTimeoutMs = options.replyTimeoutMs ?? 20_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5000;
  }
  async open(): Promise<void> {
    if (this.opened || this.closing) throw new Error('USB transport already opened or closed');
    await this.transport.open(
      (line) => this.receive(line),
      (error) => this.fail(error),
    );
    this.opened = true;
  }
  private fail(error: Error): void {
    this.failure = error;
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.pending.clear();
  }
  private receive(line: string): void {
    let reply: Record<string, unknown>;
    try {
      reply = object(JSON.parse(line) as unknown, 'reply');
    } catch {
      this.fail(new QaFailure('Malformed tagged USB QA response', 'infrastructure'));
      return;
    }
    if (typeof reply.requestId !== 'string') {
      this.fail(new QaFailure('USB QA response is missing its request ID', 'infrastructure'));
      return;
    }
    const waiting = this.pending.get(reply.requestId);
    if (!waiting) return; // Late responses cannot satisfy another request.
    this.pending.delete(reply.requestId);
    clearTimeout(waiting.timer);
    try {
      const snapshot = parseStatus(reply, {
        request: waiting.request,
        bootId: this.latest?.bootId,
        previous: this.latest,
      });
      this.latest = snapshot;
      if (waiting.request.action === 'start') this.owned = true;
      if (waiting.request.action === 'end') this.owned = false;
      this.evidence.event('fixture', snapshot);
      waiting.resolve(snapshot);
    } catch (error) {
      waiting.reject(error instanceof Error ? error : new QaFailure('Malformed USB QA response', 'infrastructure'));
    }
  }
  request(action: Action, boardUuid?: string, observeOnly = false): Promise<FixtureStatus> {
    if (observeOnly && action !== 'status') return Promise.reject(new Error('Only status may be observe-only'));
    if (action === 'drop' && (!boardUuid || !UUID.test(boardUuid)))
      return Promise.reject(new Error('Drop requires a board UUID'));
    const key = observeOnly ? 'observe' : 'owner';
    const existing = action === 'status' ? this.statusRequests.get(key) : undefined;
    if (existing) return existing;
    const response = this.tail.then(async () => {
      if (!this.opened || (this.closing && action !== 'end'))
        throw new QaFailure('USB transport is not open', 'infrastructure');
      if (this.failure && action !== 'end') throw this.failure;
      const request: FixtureRequest = {
        action,
        requestId: randomUUID(),
        ...(observeOnly ? {} : { runId: this.runId }),
        ...(boardUuid ? { boardUuid } : {}),
      };
      return await new Promise<FixtureStatus>((resolveReply, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(request.requestId);
          reject(
            new QaFailure(
              'Fixture QA response timed out; check schemaVersion 1 firmware and USB transport',
              'infrastructure',
            ),
          );
        }, this.replyTimeoutMs);
        this.pending.set(request.requestId, { request, resolve: resolveReply, reject, timer });
        try {
          this.transport.write(request);
        } catch (error) {
          clearTimeout(timer);
          this.pending.delete(request.requestId);
          reject(error instanceof Error ? error : new QaFailure('USB request failed', 'infrastructure'));
        }
      });
    });
    this.tail = response.then(
      () => undefined,
      () => undefined,
    );
    if (action !== 'status') return response;
    const coalesced = response.finally(() => this.statusRequests.delete(key));
    this.statusRequests.set(key, coalesced);
    return coalesced;
  }
  async start(): Promise<FixtureStatus> {
    if (this.owned || this.heartbeat) throw new Error('Fixture QA run already started');
    const snapshot = await this.request('start');
    this.scheduleHeartbeat();
    return snapshot;
  }
  private scheduleHeartbeat(): void {
    if (this.closing || !this.owned) return;
    this.heartbeat = setTimeout(() => {
      this.heartbeat = undefined;
      void this.request('status').then(
        () => this.scheduleHeartbeat(),
        (error: unknown) => {
          this.failure = error instanceof Error ? error : new QaFailure('Fixture heartbeat failed', 'infrastructure');
        },
      );
    }, this.heartbeatIntervalMs);
  }
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.heartbeat) clearTimeout(this.heartbeat);
    try {
      if (this.owned) await this.request('end');
    } finally {
      await this.transport.close();
      this.opened = false;
      for (const waiting of this.pending.values()) {
        clearTimeout(waiting.timer);
        waiting.reject(new QaFailure('USB transport closed', 'infrastructure'));
      }
      this.pending.clear();
    }
  }
}
