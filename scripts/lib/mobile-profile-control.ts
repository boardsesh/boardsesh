import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { WebSocket, WebSocketServer } from 'ws';
import {
  objectRecord,
  parseAck,
  parseHello,
  segmentCpu,
  type ProfileAck,
  type ProfileBoundary,
  type ProfileExpectedIdentity,
  type ProfileHello,
} from './mobile-profile-protocol';

export interface ProfileMark {
  segment: string;
  boundary: ProfileBoundary;
}
export interface ProfileSegment {
  segment: string;
  before: ProfileAck;
  after: ProfileAck;
  cpu: ReturnType<typeof segmentCpu>;
  counterDeltas: Record<string, number>;
}

/** Pure state machine; protocol timeouts retire the entire capture. */
export class ProfileCycle {
  readonly segments: ProfileSegment[] = [];
  readonly acknowledgements: ProfileAck[] = [];
  private step = 0;
  private active: ProfileAck | undefined;
  constructor(
    readonly hello: ProfileHello,
    readonly expectedMarks: readonly ProfileMark[],
  ) {}

  expect(mark: ProfileMark): void {
    const expected = this.expectedMarks[this.step];
    if (!expected || expected.segment !== mark.segment || expected.boundary !== mark.boundary)
      throw new Error('Unexpected, duplicate or out-of-order segment boundary');
  }

  accept(ack: ProfileAck): void {
    this.expect(ack);
    if (ack.runId !== this.hello.runId || ack.snapshot.pid !== this.hello.native.pid)
      throw new Error('Segment acknowledgement crossed a runtime/process identity');
    const previous = this.acknowledgements.at(-1);
    if (
      previous &&
      (ack.snapshot.monotonicMs < previous.snapshot.monotonicMs || ack.snapshot.cpuMs < previous.snapshot.cpuMs)
    )
      throw new Error('Native cumulative clocks moved backwards');
    if (previous)
      for (const [counter, count] of Object.entries(previous.counters)) {
        if ((ack.counters[counter] ?? -1) < count)
          throw new Error('Cumulative profiling counter disappeared or moved backwards');
      }
    if (ack.boundary === 'start') {
      if (this.active) throw new Error('Segments may not overlap');
      this.active = ack;
    } else if (ack.boundary === 'end') {
      if (!this.active || this.active.segment !== ack.segment) throw new Error('Segment end has no matching start');
      const counterDeltas: Record<string, number> = {};
      for (const [counter, count] of Object.entries(ack.counters))
        counterDeltas[counter] = count - (this.active.counters[counter] ?? 0);
      this.segments.push({
        segment: ack.segment,
        before: this.active,
        after: ack,
        cpu: segmentCpu(this.active.snapshot, ack.snapshot),
        counterDeltas,
      });
      this.active = undefined;
    }
    this.acknowledgements.push(ack);
    this.step += 1;
  }

  complete(): void {
    if (this.active || this.step !== this.expectedMarks.length || this.segments.length === 0)
      throw new Error('Incomplete segmented workload');
  }
}

interface PendingMark {
  requestId: string;
  mark: ProfileMark;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
  resolve(ack: ProfileAck): void;
  reject(error: Error): void;
}

export class ProfileControl {
  readonly sessionId = randomUUID();
  readonly sessionToken = randomUUID();
  readonly roundTripsMs: number[] = [];
  hello: ProfileHello | undefined;
  observedHello: unknown;
  failure: Error | undefined;
  cycle: ProfileCycle | undefined;
  private server: Server;
  private sockets: WebSocketServer;
  private client: WebSocket | undefined;
  private pending: PendingMark | undefined;
  private closing = false;
  private lastAck: ProfileAck | undefined;
  private httpMarkActive = false;

  constructor(
    private expected: ProfileExpectedIdentity,
    private appToken: string,
    readonly timeoutMs = 5000,
    readonly endSettleMs = 0,
  ) {
    if (!Number.isInteger(endSettleMs) || endSettleMs < 0 || endSettleMs > 3000)
      throw new Error('End settle timer must be bounded0..3000ms');
    this.server = createServer((request, response) => {
      if (request.method === 'GET' && request.url === '/health') {
        response.writeHead(this.failure ? 503 : 200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ready: Boolean(this.hello), valid: !this.failure }));
        return;
      }
      if (request.method !== 'POST' || request.url !== '/mark') {
        response.writeHead(404);
        response.end();
        return;
      }
      let body = '';
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString();
        if (body.length > 4096) request.destroy();
      });
      request.on('end', () => {
        void (async () => {
          try {
            const candidate = objectRecord(JSON.parse(body) as unknown);
            if (candidate.token !== this.sessionToken) throw new Error('Local mark token mismatch');
            if (!this.cycle) throw new Error('No measured/warmup cycle is active');
            if (
              typeof candidate.segment !== 'string' ||
              !/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(candidate.segment) ||
              !['start', 'end', 'sample'].includes(String(candidate.boundary))
            )
              throw new Error('Invalid workload mark');
            const mark: ProfileMark = { segment: candidate.segment, boundary: candidate.boundary as ProfileBoundary };
            if (this.httpMarkActive) throw new Error('Another HTTP mark/settle is pending');
            this.httpMarkActive = true;
            response.once('close', () => {
              if (!response.writableEnded) this.retire(new Error('Host mark disconnected before acknowledgement'));
            });
            this.cycle.expect(mark);
            if (mark.boundary === 'end' && this.endSettleMs)
              await new Promise((settled) => setTimeout(settled, this.endSettleMs));
            const ack = await this.mark(mark);
            this.cycle.accept(ack);
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ acknowledged: true, segment: ack.segment, boundary: ack.boundary }));
          } catch (error) {
            this.retire(error instanceof Error ? error : new Error(String(error)));
            response.writeHead(409, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ acknowledged: false, error: this.failure?.message }));
          } finally {
            this.httpMarkActive = false;
          }
        })();
      });
    });
    this.sockets = new WebSocketServer({ server: this.server, maxPayload: 32768 });
    this.sockets.on('connection', (socket, request) => {
      if (
        new URL(request.url ?? '/', 'http://localhost').searchParams.get('token') !== this.appToken ||
        this.client ||
        this.failure
      ) {
        socket.close();
        return;
      }
      this.client = socket;
      socket.on('message', (bytes) => {
        try {
          const payload = Array.isArray(bytes)
            ? Buffer.concat(bytes)
            : Buffer.isBuffer(bytes)
              ? bytes
              : Buffer.from(new Uint8Array(bytes));
          const message: unknown = JSON.parse(payload.toString('utf8'));
          if (!this.hello) {
            this.observedHello = message;
            this.hello = parseHello(message, this.expected);
            socket.send(JSON.stringify({ type: 'welcome', sessionId: this.sessionId }));
            return;
          }
          const ack = parseAck(message);
          const pending = this.pending;
          if (
            !pending ||
            ack.requestId !== pending.requestId ||
            ack.sessionId !== this.sessionId ||
            ack.runId !== this.hello.runId ||
            ack.segment !== pending.mark.segment ||
            ack.boundary !== pending.mark.boundary ||
            ack.snapshot.pid !== this.hello.native.pid
          )
            throw new Error('Stale or mismatched native acknowledgement');
          if (
            this.lastAck &&
            (ack.snapshot.cpuMs < this.lastAck.snapshot.cpuMs ||
              ack.snapshot.monotonicMs < this.lastAck.snapshot.monotonicMs)
          )
            throw new Error('Native cumulative clock discontinuity');
          if (this.lastAck)
            for (const [counter, count] of Object.entries(this.lastAck.counters)) {
              if ((ack.counters[counter] ?? -1) < count)
                throw new Error('Native cumulative counter disappeared or moved backwards across capture');
            }
          clearTimeout(pending.timer);
          this.pending = undefined;
          this.lastAck = ack;
          this.roundTripsMs.push(performance.now() - pending.startedAt);
          pending.resolve(ack);
        } catch (error) {
          this.retire(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.on('close', () => {
        if (!this.closing) this.retire(new Error('Profiling runtime disconnected; reconnect cannot salvage capture'));
      });
      socket.on('error', () => this.retire(new Error('Profiling control transport failed')));
    });
  }

  async listen(port: number, address = '127.0.0.1'): Promise<void> {
    await new Promise<void>((resolveListen, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, address, () => {
        this.server.off('error', reject);
        resolveListen();
      });
    });
  }

  async waitForHello(timeoutMs = 45_000): Promise<ProfileHello> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      if (this.failure) throw this.failure;
      if (this.hello) return this.hello;
      await new Promise((resolvePoll) => setTimeout(resolvePoll, 50));
    }
    this.retire(new Error('No matching physical Release runtime identity within the readiness deadline'));
    throw this.failure;
  }

  mark(mark: ProfileMark): Promise<ProfileAck> {
    if (this.failure) return Promise.reject(this.failure);
    if (!this.hello || !this.client || this.client.readyState !== WebSocket.OPEN || this.pending)
      return Promise.reject(new Error('Runtime not ready or another mark is pending'));
    const requestId = randomUUID();
    return new Promise<ProfileAck>((resolveAck, reject) => {
      const timer = setTimeout(
        () => this.retire(new Error('Native boundary acknowledgement timed out; capture retired')),
        this.timeoutMs,
      );
      this.pending = { requestId, mark, timer, startedAt: performance.now(), resolve: resolveAck, reject };
      this.client?.send(JSON.stringify({ type: 'mark', requestId, sessionId: this.sessionId, ...mark }), (error) => {
        if (error) this.retire(new Error('Native boundary send failed'));
      });
    });
  }

  beginCycle(expectedMarks: readonly ProfileMark[]): ProfileCycle {
    if (this.failure) throw this.failure;
    if (!this.hello || this.cycle) throw new Error('Runtime not ready or cycle already active');
    this.cycle = new ProfileCycle(this.hello, expectedMarks);
    return this.cycle;
  }

  finishCycle(): ProfileCycle {
    if (this.failure) throw this.failure;
    if (!this.cycle) throw new Error('No active profiling cycle');
    this.cycle.complete();
    const completed = this.cycle;
    this.cycle = undefined;
    return completed;
  }

  retire(error: Error): void {
    this.failure ??= error;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(this.failure);
      this.pending = undefined;
    }
    this.client?.close();
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.pending) this.retire(new Error('Capture closed with an unfinished native mark'));
    for (const client of this.sockets.clients) client.terminate();
    await new Promise<void>((resolveClose) => this.sockets.close(() => resolveClose()));
    if (this.server.listening) await new Promise<void>((resolveClose) => this.server.close(() => resolveClose()));
  }
}
