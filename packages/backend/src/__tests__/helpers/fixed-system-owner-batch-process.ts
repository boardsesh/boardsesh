import { fork, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BatchSystemUserCommand } from '@boardsesh/auth-protocol';
import type { ExpectedCurrentStoreAuthority } from '../../auth/current-store/foundation-context';

export interface FixedSystemOwnerActorResult {
  outcome: 'ensured' | 'busy' | 'failed';
  postgresCode?: string;
  poolClosed: boolean;
  childClosed: boolean;
  groupDrained: boolean;
}

/** Actual separate Node/SQL process; private fixture input travels only over IPC. */
export function startFixedSystemOwnerBatchActor(input: {
  authority: ExpectedCurrentStoreAuthority;
  command: BatchSystemUserCommand;
  holdBeforeCommit: boolean;
}) {
  const captured = {
    authority: { ...input.authority },
    command: { ...input.command, payload: { ...input.command.payload } },
    holdBeforeCommit: input.holdBeforeCommit,
  };
  const address = new URL(process.env.DATABASE_URL ?? 'invalid:');
  const databaseName = address.pathname.slice(1);
  if (!/^boardsesh_backend_test_w\d+(?:_[a-f0-9]{12})?$/.test(databaseName)) {
    throw new Error('Explicit owned worker database required');
  }
  const child = fork(fileURLToPath(new URL('./fixed-system-owner-batch-actor.ts', import.meta.url)), [], {
    execArgv: ['--import', 'tsx'],
    detached: true,
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      NODE_PATH: '',
      READ_REPLICA_URL: '',
      DEBUG_SQL: 'false',
      BOARDSESH_FIXED_OWNER_FIXTURE_DB_NAME: databaseName,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let resolveHeld!: (held: boolean) => void;
  let resolveResult!: (result: FixedSystemOwnerActorResult) => void;
  const held = new Promise<boolean>((resolve) => {
    resolveHeld = resolve;
  });
  const result = new Promise<FixedSystemOwnerActorResult>((resolve) => {
    resolveResult = resolve;
  });
  let heldReported = false;
  let finished = false;
  let failure: string | undefined;
  let reported: { outcome: 'ensured' | 'busy' | 'failed'; postgresCode?: string; poolClosed: boolean } | undefined;
  let outputBytes = 0;
  const privateOutput: Buffer[] = [];
  let escalation: ReturnType<typeof setTimeout> | undefined;
  function signalGroup(signal: NodeJS.Signals): void {
    if (!child.pid || child.pid <= 1 || child.pid === process.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH')) {
        failure ??= 'signal';
      }
    }
  }
  function stop(reason: string): void {
    failure ??= reason;
    if (child.connected) child.send({ type: 'abort' }, () => {});
    signalGroup('SIGTERM');
    escalation ??= setTimeout(() => signalGroup('SIGKILL'), 1_000);
  }
  const parentSignal = () => stop('parent-signal');
  const parentExit = () => {
    failure ??= 'parent-exit';
    // Exit handlers cannot await IPC or timers. The captured detached group
    // must not outlive a parent that is already exiting.
    signalGroup('SIGKILL');
  };
  process.once('SIGTERM', parentSignal);
  process.once('SIGINT', parentSignal);
  process.once('exit', parentExit);
  const removeParentHandlers = () => {
    process.removeListener('SIGTERM', parentSignal);
    process.removeListener('SIGINT', parentSignal);
    process.removeListener('exit', parentExit);
  };
  function groupAlive(): boolean {
    if (!child.pid) return false;
    const listing = execFileSync('ps', ['-eo', 'pgid=,stat='], {
      encoding: 'utf8',
      timeout: 1_000,
      maxBuffer: 1024 * 1024,
      // Next's ambient ProcessEnv type requires NODE_ENV even for external ps.
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', NODE_ENV: 'test' },
    });
    return listing.split('\n').some((line) => {
      const [group, state] = line.trim().split(/\s+/);
      return Number(group) === child.pid && !state?.startsWith('Z');
    });
  }
  const deadline = setTimeout(() => stop('deadline'), 12_000);
  const capture = (chunk: Buffer) => {
    const remaining = Math.max(0, 65_536 - outputBytes);
    if (remaining > 0) privateOutput.push(Buffer.from(chunk.subarray(0, remaining)));
    outputBytes += chunk.length;
    if (outputBytes > 65_536) stop('output-limit');
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  child.once('error', () => stop('spawn'));
  child.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null || !('type' in message)) return;
    if (message.type === 'ready') {
      if (failure) stop(failure);
      else child.send({ type: 'run', ...captured }, (error) => error && stop('input'));
    } else if (message.type === 'held') {
      heldReported = true;
      resolveHeld(true);
    } else if (message.type === 'result') {
      if (
        !('outcome' in message) ||
        !['ensured', 'busy', 'failed'].includes(String(message.outcome)) ||
        !('poolClosed' in message) ||
        typeof message.poolClosed !== 'boolean' ||
        ('postgresCode' in message &&
          message.postgresCode !== undefined &&
          (typeof message.postgresCode !== 'string' || !/^[A-Z0-9]{5}$/.test(message.postgresCode)))
      ) {
        stop('protocol');
        return;
      }
      reported = {
        outcome: message.outcome as 'ensured' | 'busy' | 'failed',
        poolClosed: message.poolClosed,
        ...('postgresCode' in message && typeof message.postgresCode === 'string'
          ? { postgresCode: message.postgresCode }
          : {}),
      };
    } else if (message.type === 'failure') stop('actor');
  });
  child.once('close', (code, signal) => {
    void (async () => {
      clearTimeout(deadline);
      let groupDrained = false;
      try {
        const drainDeadline = performance.now() + 500;
        while (groupAlive() && performance.now() < drainDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (groupAlive()) {
          stop('descendants-after-close');
          const killDeadline = performance.now() + 2_000;
          while (groupAlive() && performance.now() < killDeadline) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
        groupDrained = !groupAlive();
      } catch {
        failure ??= 'group-inspection';
      }
      if (!groupDrained) signalGroup('SIGKILL');
      if (escalation) clearTimeout(escalation);
      removeParentHandlers();
      const positive = code === 0 && signal === null && !failure && groupDrained && reported?.poolClosed === true;
      if (!positive) {
        const directory = fileURLToPath(new URL('../../../../../.boardsesh/', import.meta.url));
        mkdirSync(directory, { recursive: true });
        writeFileSync(`${directory}/fixed-owner-actor-${randomUUID()}.private.log`, Buffer.concat(privateOutput), {
          flag: 'wx',
          mode: 0o600,
        });
      }
      finished = true;
      resolveHeld(false);
      resolveResult({
        outcome: positive && reported ? reported.outcome : 'failed',
        ...(reported?.postgresCode ? { postgresCode: reported.postgresCode } : {}),
        poolClosed: reported?.poolClosed === true,
        childClosed: true,
        groupDrained,
      });
    })().catch(() => {
      signalGroup('SIGKILL');
      if (escalation) clearTimeout(escalation);
      removeParentHandlers();
      finished = true;
      resolveHeld(false);
      resolveResult({ outcome: 'failed', poolClosed: false, childClosed: true, groupDrained: false });
    });
  });
  return {
    held,
    result,
    release() {
      if (!heldReported || !child.connected) throw new Error('Owned actor is not held');
      child.send({ type: 'release' }, (error) => error && stop('release'));
    },
    async stop() {
      if (!finished) stop('cancelled');
      await result;
    },
  };
}
