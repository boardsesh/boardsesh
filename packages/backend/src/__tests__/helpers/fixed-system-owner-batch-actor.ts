// Native child only: no dotenv, worker-schema creation or app client before admission.
import type { DbInstance } from '@boardsesh/db/client';

function send(message: object): void {
  if (process.connected) process.send?.(message);
}

function requireOwnedWorker(): void {
  const address = new URL(process.env.DATABASE_URL ?? 'invalid:');
  const expectedName = process.env.BOARDSESH_FIXED_OWNER_FIXTURE_DB_NAME ?? '';
  // Canonical 5433 follows the existing backend test workflow, rather than the
  // separately attested 15478 fixture. The owned QA launcher never selects it.
  const canonicalTestWorkflow =
    (['1', 'true'].includes(process.env.CI ?? '') && process.env.GITHUB_ACTIONS === 'true') ||
    (process.env.VITEST === 'true' && !process.env.CI && process.env.SKIP_TEST_INFRA !== '1');
  if (
    !process.send ||
    !['postgres:', 'postgresql:'].includes(address.protocol) ||
    process.env.NODE_ENV !== 'test' ||
    process.env.VITEST !== 'true' ||
    !/^boardsesh_backend_test_w\d+(?:_[a-f0-9]{12})?$/.test(expectedName) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) ||
    !(address.port === '15478' || (address.port === '5433' && canonicalTestWorkflow)) ||
    address.pathname !== `/${expectedName}` ||
    !address.password ||
    address.search ||
    address.hash ||
    process.env.READ_REPLICA_URL ||
    process.env.DEBUG_SQL !== 'false'
  ) {
    throw new Error('Explicit owned fixed-owner worker required');
  }
}

let release: (() => void) | undefined;
let abort: (() => void) | undefined;
let runStarted = false;
let holding = false;
process.on('message', (message: unknown) => {
  if (typeof message !== 'object' || message === null || !('type' in message)) return;
  if (message.type === 'release' && holding) release?.();
  if (message.type === 'abort') abort?.();
});
process.once('disconnect', () => {
  if (abort) abort();
  else process.exit(1);
});

try {
  requireOwnedWorker();
  const [{ z }, { batchSystemUserCommandSchema }, { default: postgres }, { drizzle }, commandModule, lockModule] =
    await Promise.all([
      import('zod'),
      import('@boardsesh/auth-protocol'),
      import('postgres'),
      import('drizzle-orm/postgres-js'),
      import('../../auth/current-store/batch-system-user'),
      import('@boardsesh/db/fixed-system-owner-order'),
    ]);
  const requestSchema = z
    .object({
      type: z.literal('run'),
      holdBeforeCommit: z.boolean(),
      authority: z
        .object({
          expectedProjectionId: z.string().min(1).max(256),
          expectedNormalizerVersion: z.literal('js-trim-lower-v1'),
          expectedWriterEpoch: z.number().int().positive(),
        })
        .strict(),
      command: batchSystemUserCommandSchema,
    })
    .strict();

  process.on('message', (message: unknown) => {
    if (runStarted) return;
    const parsed = requestSchema.safeParse(message);
    if (!parsed.success) return;
    runStarted = true;
    void (async () => {
      let closedConnections = 0;
      const pool = postgres(process.env.DATABASE_URL!, {
        max: 1,
        connect_timeout: 3,
        idle_timeout: 0,
        onnotice: () => {},
        onclose: () => {
          closedConnections += 1;
        },
      });
      const database = drizzle(pool) as unknown as DbInstance;
      let rejectHold: ((reason: Error) => void) | undefined;
      const heldUntilRelease = new Promise<void>((resolve, reject) => {
        release = resolve;
        rejectHold = reject;
      });
      // No unhandled rejection when this operation does not pause before commit.
      void heldUntilRelease.catch(() => {});
      abort = () => rejectHold?.(new Error('Owned actor cancelled'));
      const controlledTransaction: DbInstance['transaction'] = async (callback, configuration) =>
        database.transaction(async (transaction) => {
          const result = await callback(transaction);
          if (parsed.data.holdBeforeCommit) {
            // The actual command/fence callback completed, with its run/job,
            // manifest, owner key and identity locks still held in this TX.
            holding = true;
            send({ type: 'held' });
            await heldUntilRelease;
            holding = false;
          }
          return result;
        }, configuration);
      const controlledDatabase = new Proxy(database, {
        get(target, property, receiver) {
          return property === 'transaction' ? controlledTransaction : Reflect.get(target, property, receiver);
        },
      });
      let outcome: 'ensured' | 'busy' | 'failed' = 'failed';
      let postgresCode: string | undefined;
      let poolClosed = false;
      try {
        await commandModule.executeBatchSystemUserCommand(
          controlledDatabase,
          parsed.data.authority,
          parsed.data.command,
          performance.now() + 8_000,
        );
        outcome = 'ensured';
      } catch (error) {
        if (error instanceof lockModule.FixedSystemOwnerOrderError && error.code === 'busy') outcome = 'busy';
        const visited = new Set<unknown>();
        let current: unknown = error;
        for (let depth = 0; depth < 8 && typeof current === 'object' && current !== null; depth += 1) {
          if (visited.has(current)) break;
          visited.add(current);
          if ('code' in current && typeof current.code === 'string' && /^[A-Z0-9]{5}$/.test(current.code)) {
            postgresCode = current.code;
            break;
          }
          current = 'cause' in current ? current.cause : undefined;
        }
      } finally {
        const before = closedConnections;
        await pool.end({ timeout: 1 });
        const deadline = performance.now() + 2_000;
        while (closedConnections === before && performance.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        poolClosed = closedConnections > before;
      }
      await new Promise<void>((resolve, reject) => {
        if (!process.connected || !process.send) {
          reject(new Error('Owned actor disconnected before result acknowledgement'));
          return;
        }
        process.send({ type: 'result', outcome, postgresCode, poolClosed }, (error) =>
          error ? reject(error) : resolve(),
        );
      });
      process.exitCode = poolClosed && outcome !== 'failed' ? 0 : 1;
      process.disconnect?.();
    })().catch(() => {
      send({ type: 'failure' });
      process.exitCode = 1;
      process.disconnect?.();
    });
  });
  send({ type: 'ready' });
} catch {
  send({ type: 'failure' });
  process.exitCode = 1;
  process.disconnect?.();
}
