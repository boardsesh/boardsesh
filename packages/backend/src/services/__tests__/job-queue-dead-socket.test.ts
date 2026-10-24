import { once } from 'node:events';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WORKER_JOB_QUEUE_QUERY_TIMEOUT_MS, createJobQueueClient } from '../job-queue-client';

vi.mock('../../utils/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

/**
 * #6683 reproduced on a real socket. The fake server finishes the Postgres
 * startup handshake, then reads the first connection's first query and never
 * answers it while keeping the socket open. The kernel has acknowledged the
 * bytes, so nothing on the client side ever errors. That is what a TCP proxy
 * does when its upstream leg vanishes. Every later connection is answered, in
 * the simple protocol and in the extended one that pg uses for a parameterised
 * query such as pg-boss's fetch.
 */

const SSL_REQUEST_CODE = 80877103;
const CONNECTION_TIMEOUT_MS = 10_000; // createJobQueueClient's connectionTimeoutMillis

function backendMessage(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.write(type, 0, 'latin1');
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}

const AUTHENTICATION_OK = backendMessage('R', Buffer.from([0, 0, 0, 0]));
const READY_FOR_QUERY = backendMessage('Z', Buffer.from('I', 'latin1'));
const COMMAND_COMPLETE = backendMessage('C', Buffer.from('SELECT 0\0', 'latin1'));
// Answers Parse, Bind, Describe (portal) and Execute, in order, once their Sync arrives.
const EXTENDED_QUERY_REPLY = Buffer.concat([
  backendMessage('1', Buffer.alloc(0)),
  backendMessage('2', Buffer.alloc(0)),
  backendMessage('n', Buffer.alloc(0)),
  COMMAND_COMPLETE,
  READY_FOR_QUERY,
]);

async function startSilentAfterAckPostgres() {
  const sockets: Socket[] = [];
  let resolveSwallowed: () => void = () => {};
  const swallowed = new Promise<void>((resolve) => {
    resolveSwallowed = resolve;
  });
  const server = createServer((socket) => {
    const connection = sockets.push(socket) - 1;
    let pending = Buffer.alloc(0);
    let started = false;
    socket.on('error', () => {});
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        if (!started) {
          if (pending.length < 8 || pending.length < pending.readInt32BE(0)) return;
          const length = pending.readInt32BE(0);
          const code = pending.readInt32BE(4);
          pending = pending.subarray(length);
          if (code === SSL_REQUEST_CODE) {
            socket.write('N');
            continue;
          }
          started = true;
          socket.write(Buffer.concat([AUTHENTICATION_OK, READY_FOR_QUERY]));
          continue;
        }
        if (pending.length < 5 || pending.length < pending.readInt32BE(1) + 1) return;
        const type = String.fromCharCode(pending.readUInt8(0));
        pending = pending.subarray(pending.readInt32BE(1) + 1);
        // A simple query ends at its Q message, an extended one at its Sync.
        if (type !== 'Q' && type !== 'S') continue;
        if (connection === 0) {
          // Received and acknowledged, never answered.
          resolveSwallowed();
          continue;
        }
        socket.write(type === 'Q' ? Buffer.concat([COMMAND_COMPLETE, READY_FOR_QUERY]) : EXTENDED_QUERY_REPLY);
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    connectionString: `postgres://worker@127.0.0.1:${port}/boardsesh`,
    sockets,
    swallowed,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** pg-boss's default Db, opened without starting pg-boss itself. */
type QueuePool = {
  open(): Promise<void>;
  close(): Promise<void>;
  executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
};

function track(promise: Promise<unknown>) {
  const state: { settled: boolean; error: unknown } = { settled: false, error: undefined };
  void promise.then(
    () => {
      state.settled = true;
    },
    (error: unknown) => {
      state.settled = true;
      state.error = error;
    },
  );
  return state;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  // Closing the server first ends every socket, which releases a client stuck in the pool.
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function openPool(owner: 'worker' | 'backend') {
  const server = await startSilentAfterAckPostgres();
  const boss = createJobQueueClient({ connectionString: server.connectionString, poolSize: 1, owner });
  const pool = boss.getDb() as unknown as QueuePool;
  await pool.open();
  cleanups.push(() => pool.close());
  cleanups.push(() => server.close());
  // Only timers are faked; sockets stay real.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  return { server, pool };
}

describe('a job-queue query that never gets an answer (#6683)', () => {
  it('worker pool: drops the stuck query and its socket, then serves the next query on a fresh connection', async () => {
    const { server, pool } = await openPool('worker');

    const stuck = track(pool.executeSql('SELECT $1::int AS fetched', [1]));
    await server.swallowed;
    await vi.advanceTimersByTimeAsync(WORKER_JOB_QUEUE_QUERY_TIMEOUT_MS);

    expect(stuck.settled).toBe(true);
    expect(stuck.error).toMatchObject({ message: 'Query read timeout' });
    // pg destroyed the dead socket rather than leaving it to linger.
    if (!server.sockets[0].destroyed) await once(server.sockets[0], 'close');

    await expect(pool.executeSql('SELECT $1::int AS fetched', [1])).resolves.toMatchObject({ rows: [] });
    expect(server.sockets).toHaveLength(2);
  });

  it('backend pool, which has no read deadline: the stuck query keeps the only slot and every checkout times out', async () => {
    const { server, pool } = await openPool('backend');

    const stuck = track(pool.executeSql('SELECT 1'));
    await server.swallowed;
    const next = track(pool.executeSql('SELECT 1'));
    await vi.advanceTimersByTimeAsync(CONNECTION_TIMEOUT_MS);

    // The exact error the homelab workers logged once a minute for three days.
    expect(next.error).toMatchObject({ message: 'timeout exceeded when trying to connect' });
    await vi.advanceTimersByTimeAsync(WORKER_JOB_QUEUE_QUERY_TIMEOUT_MS * 10);
    expect(stuck.settled).toBe(false);
    expect(server.sockets).toHaveLength(1);
  });
});
