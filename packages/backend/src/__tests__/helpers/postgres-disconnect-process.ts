import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Duplex } from 'node:stream';
import type postgresTypes from 'postgres';

// Run in a child process: the original bug throws on the immediate queue,
// outside the query promise. A parent timeout also detects a silently wedged pool.
const [entryPoint, scenario] = process.argv.slice(2);
const postgres: typeof postgresTypes =
  entryPoint === 'cjs' ? createRequire(import.meta.url)('postgres') : (await import('postgres')).default;

function frame(type: string, payload = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(5);
  header.write(type);
  header.writeInt32BE(payload.length + 4, 1);
  return Buffer.concat([header, payload]);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function simulatedDisconnect(): Promise<void> {
  const statements: { socket: number; statement: string }[] = [];
  const sockets: DatabaseSocket[] = [];
  const failedStatementsSettled = deferred();
  const resumeTransaction = deferred();
  const delayedStatementSettled = deferred();
  let didDisconnect = false;

  class DatabaseSocket extends Duplex {
    readonly socketNumber = sockets.length + 1;
    private started = false;
    private closing = false;
    private parsedStatement = '';
    private transactionState = 'I';

    constructor() {
      super();
      sockets.push(this);
      // This immediate precedes the driver's buffered startup write. Closing
      // must reset its timer as well as cancel it, or reconnect never flushes.
      if (scenario === 'startup' && this.socketNumber === 1) setImmediate(() => this.destroy());
    }

    override _read(): void {}

    private respond(frames: Buffer[]): void {
      setImmediate(() => {
        if (!this.destroyed && !this.closing) this.push(Buffer.concat(frames));
      });
    }

    private ready(): Buffer {
      return frame('Z', Buffer.from(this.transactionState));
    }

    private executeStatement(statement: string): Buffer[] {
      statements.push({ socket: this.socketNumber, statement });
      if (statement === 'select disconnect' && !didDisconnect) {
        didDisconnect = this.closing = true;
        if (scenario === 'fatal') {
          this.push(frame('E', Buffer.from('SFATAL\0C57P01\0Mterminating connection\0\0')));
        }
        setImmediate(() =>
          this.destroy(
            scenario === 'error' ? Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }) : undefined,
          ),
        );
        return [];
      }
      if (statement.startsWith('begin')) this.transactionState = 'T';
      if (statement === 'commit' || statement === 'rollback') this.transactionState = 'I';
      const command = statement.startsWith('select') ? 'SELECT 1' : statement.trim().toUpperCase();
      return [frame('C', Buffer.from(`${command}\0`))];
    }

    override _write(bytes: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      if (!this.started) {
        this.started = true;
        this.respond([this.ready()]);
        callback();
        return;
      }
      const responses: Buffer[] = [];
      // A batch may contain several complete simple/extended protocol frames.
      for (let offset = 0; offset < bytes.length && !this.closing;) {
        const type = String.fromCharCode(bytes[offset]);
        const size = bytes.readInt32BE(offset + 1);
        const payload = bytes.subarray(offset + 5, offset + size + 1);
        offset += size + 1;
        if (type === 'Q') {
          responses.push(...this.executeStatement(payload.toString('utf8', 0, payload.length - 1)), this.ready());
        } else if (type === 'P') {
          const nameEnd = payload.indexOf(0);
          this.parsedStatement = payload.toString('utf8', nameEnd + 1, payload.indexOf(0, nameEnd + 1));
          responses.push(frame('1'));
        } else if (type === 'D') {
          responses.push(frame('n'));
        } else if (type === 'B') {
          responses.push(frame('2'));
        } else if (type === 'E') {
          responses.push(...this.executeStatement(this.parsedStatement));
        } else if (type === 'S') {
          responses.push(this.ready());
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

  // These two driver-supported test controls are absent from its public types.
  const poolOptions = {
    max: 1,
    max_pipeline: 1,
    fetch_types: false,
    prepare: false,
    idle_timeout: 0,
    max_lifetime: 0,
    backoff: () => 0,
    socket: () => new DatabaseSocket(),
  };
  const pool = postgres('postgres://test:test@localhost/test', poolOptions);
  try {
    if (scenario === 'startup') {
      await pool.unsafe('select startup_recovered');
      assert.equal(sockets.length, 2);
      assert.equal(statements.filter(({ statement }) => statement === 'select startup_recovered').length, 1);
    } else {
      const transaction = pool.begin(async (sql) => {
        const outcomes = await Promise.allSettled([
          sql.unsafe('select disconnect'),
          sql.unsafe('select pipelined'),
          sql.unsafe('select queued'),
        ]);
        assert.ok(outcomes.every((outcome) => outcome.status === 'rejected'));
        failedStatementsSettled.resolve();
        if (scenario === 'delayed') {
          await resumeTransaction.promise;
          await assert.rejects(sql.unsafe('select stale_transaction'), { code: 'CONNECTION_CLOSED' });
          delayedStatementSettled.resolve();
        } else {
          throw new Error('transaction must roll back');
        }
      });
      await assert.rejects(transaction, { code: 'CONNECTION_CLOSED' });
      await failedStatementsSettled.promise;
      // Let automatic rollback and its deferred write run before recovery.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    for (let index = 0; index < 3; index++) await pool.unsafe(`select recovered_${index}`);
    if (scenario === 'delayed') {
      resumeTransaction.resolve();
      await delayedStatementSettled.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await pool.begin(async (sql) => {
      await sql.unsafe('select fresh_transaction');
    });
    assert.ok(statements.some(({ statement }) => statement === 'commit'));
    assert.ok(
      !statements.some(({ socket, statement }) => socket > 1 && /disconnect|pipelined|queued|stale/.test(statement)),
    );
    if (scenario !== 'startup') assert.ok(!statements.some(({ statement }) => statement === 'rollback'));
    for (let index = 0; index < 3; index++) {
      assert.equal(statements.filter(({ statement }) => statement === `select recovered_${index}`).length, 1);
    }
  } finally {
    resumeTransaction.resolve();
    await pool.end({ timeout: 0 });
    for (const socket of sockets) socket.destroy();
  }
}

async function realDisconnect(): Promise<void> {
  const pool = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false, backoff: () => 0 });
  const admin = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
  try {
    await assert.rejects(
      pool.begin(async (sql) => {
        const [{ pid }] = await sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
        // Only terminate this test's connection, never the database service.
        await admin`select pg_terminate_backend(${pid})`;
        await sql`select 1`;
      }),
    );
    for (let index = 0; index < 3; index++) {
      assert.equal((await pool`select 42 as answer`)[0].answer, 42);
    }
    await pool.begin(async (sql) => {
      assert.equal((await sql`select 43 as answer`)[0].answer, 43);
      await assert.rejects(
        sql.savepoint(async (savepoint) => {
          await savepoint`select 1`;
          throw new Error('savepoint rollback');
        }),
        /savepoint rollback/,
      );
      assert.equal((await sql`select 44 as answer`)[0].answer, 44);
    });
    await assert.rejects(
      pool.begin(async (sql) => {
        await sql`select 1`;
        throw new Error('ordinary rollback');
      }),
      /ordinary rollback/,
    );
    assert.equal((await pool`select 45 as answer`)[0].answer, 45);
  } finally {
    await pool.end({ timeout: 0 });
    await admin.end({ timeout: 0 });
  }
}

if (scenario === 'live') await realDisconnect();
else await simulatedDisconnect();
process.stdout.write('disconnect recovery verified\n');
