import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Duplex } from 'node:stream';
import type postgresTypes from 'postgres';
import { setDbConnectObserver, withConnectRetry } from '@boardsesh/db/client';

// Runs in a child process so an unhandled rejection is observed, not swallowed
// by the test runner. A fake PgBouncer answers the startup packet, then fails
// the first statement on the connection (postgres.js's array-type fetch) the way
// PgBouncer does on `query_wait_timeout`: a FATAL 08P01 and a closed socket.
const [entryPoint, scenario] = process.argv.slice(2);
const postgres: typeof postgresTypes =
  entryPoint === 'cjs' ? createRequire(import.meta.url)('postgres') : (await import('postgres')).default;

const unhandledRejections: unknown[] = [];
process.on('unhandledRejection', (reason) => unhandledRejections.push(reason));

const CALLER_STATEMENT = 'select caller_statement';

function frame(type: string, payload = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(5);
  header.write(type);
  header.writeInt32BE(payload.length + 4, 1);
  return Buffer.concat([header, payload]);
}

const queryWaitTimeout = frame('E', Buffer.from('SFATAL\0VFATAL\0C08P01\0Mquery_wait_timeout\0\0'));

/** `fail` sockets reject their first statement like PgBouncer; `close` sockets hang up without an error. */
type SocketBehaviour = 'fail' | 'close' | 'serve';

const statements: { socket: number; statement: string }[] = [];
const sockets: FakePgBouncerSocket[] = [];

class FakePgBouncerSocket extends Duplex {
  readonly socketNumber = sockets.length + 1;
  private started = false;
  private closing = false;
  private parsedStatement = '';

  constructor(private readonly behaviour: SocketBehaviour) {
    super();
    sockets.push(this);
  }

  override _read(): void {}

  private respond(frames: Buffer[]): void {
    setImmediate(() => {
      if (!this.destroyed && !this.closing) this.push(Buffer.concat(frames));
    });
  }

  private hangUp(withError: boolean): void {
    this.closing = true;
    setImmediate(() => {
      if (withError) this.push(queryWaitTimeout);
      this.push(null);
      setImmediate(() => this.destroy());
    });
  }

  override _write(bytes: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (!this.started) {
      this.started = true;
      this.respond([frame('R', Buffer.from([0, 0, 0, 0])), frame('Z', Buffer.from('I'))]);
      callback();
      return;
    }
    if (this.behaviour !== 'serve') {
      // PgBouncer holds the packet while the client waits; nothing is executed.
      if (!this.closing) this.hangUp(this.behaviour === 'fail');
      callback();
      return;
    }
    const responses: Buffer[] = [];
    for (let offset = 0; offset < bytes.length;) {
      const type = String.fromCharCode(bytes[offset]);
      const size = bytes.readInt32BE(offset + 1);
      const payload = bytes.subarray(offset + 5, offset + size + 1);
      offset += size + 1;
      if (type === 'Q') {
        const statement = payload.toString('utf8', 0, payload.length - 1).trim();
        statements.push({ socket: this.socketNumber, statement });
        responses.push(frame('C', Buffer.from('SELECT 0\0')), frame('Z', Buffer.from('I')));
      } else if (type === 'P') {
        const nameEnd = payload.indexOf(0);
        this.parsedStatement = payload.toString('utf8', nameEnd + 1, payload.indexOf(0, nameEnd + 1)).trim();
        responses.push(frame('1'));
      } else if (type === 'B') {
        responses.push(frame('2'));
      } else if (type === 'D') {
        responses.push(frame('n'));
      } else if (type === 'E') {
        statements.push({ socket: this.socketNumber, statement: this.parsedStatement });
        responses.push(frame('C', Buffer.from('SELECT 0\0')));
      } else if (type === 'S') {
        responses.push(frame('Z', Buffer.from('I')));
      } else if (type === 'X') {
        this.destroy();
      } else {
        assert.fail(`Unexpected protocol frame: ${type}`);
      }
    }
    if (responses.length) this.respond(responses);
    callback();
  }
}

function createPool(behaviours: SocketBehaviour[]) {
  // `socket` and `backoff` are driver-supported controls absent from its public types.
  const poolOptions = {
    max: 1,
    prepare: false,
    idle_timeout: 0,
    max_lifetime: 0,
    backoff: () => 0,
    socket: () => new FakePgBouncerSocket(behaviours[sockets.length] ?? 'serve'),
  };
  return postgres('postgres://pooler@fake-pgbouncer:6432/boardsesh', poolOptions as Parameters<typeof postgres>[1]);
}

async function settleAndCheckUnhandled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(unhandledRejections.length, 0, `unhandled rejections: ${String(unhandledRejections)}`);
}

async function failedTypeFetch(): Promise<void> {
  const pool = createPool(['fail']);
  try {
    await assert.rejects(pool.unsafe(CALLER_STATEMENT), { code: '08P01', message: 'query_wait_timeout' });
    await settleAndCheckUnhandled();
    // The connect failed with the pooler's error; it did not loop reconnecting.
    assert.equal(sockets.length, 1);
    assert.equal(statements.length, 0);
  } finally {
    await pool.end({ timeout: 0 });
  }
}

async function retriedTypeFetch(): Promise<void> {
  const retryCodes: string[] = [];
  setDbConnectObserver((event) => retryCodes.push(event.code));
  const pool = createPool(['fail', 'serve']);
  const retrying = withConnectRetry(pool, { sleep: () => Promise.resolve() });
  try {
    await retrying.unsafe(CALLER_STATEMENT);
    await settleAndCheckUnhandled();
    assert.deepEqual(retryCodes, ['08P01:query_wait_timeout']);
    // Written exactly once, on the replacement connection.
    assert.deepEqual(
      statements.filter(({ statement }) => statement === CALLER_STATEMENT),
      [{ socket: 2, statement: CALLER_STATEMENT }],
    );
  } finally {
    setDbConnectObserver(null);
    await pool.end({ timeout: 0 });
  }
}

async function closedTypeFetch(): Promise<void> {
  const pool = createPool(['close', 'serve']);
  try {
    // No error frame: postgres.js reconnects, and the replacement socket must not
    // inherit the abandoned type fetch as a stale in-flight query.
    await pool.unsafe(CALLER_STATEMENT);
    await settleAndCheckUnhandled();
    assert.deepEqual(
      statements.filter(({ statement }) => statement === CALLER_STATEMENT),
      [{ socket: 2, statement: CALLER_STATEMENT }],
    );
  } finally {
    await pool.end({ timeout: 0 });
  }
}

if (scenario === 'fatal') await failedTypeFetch();
else if (scenario === 'retry') await retriedTypeFetch();
else if (scenario === 'close') await closedTypeFetch();
else assert.fail(`unknown scenario: ${scenario}`);
process.stdout.write('pgbouncer startup rejection verified\n');
process.exit(0);
