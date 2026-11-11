import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { keyedReference, RehearsalSafetyError } from './target-guard';
import { runtimeChildEnvironment, type RuntimeFixture } from './isolated-runtime';

export interface WorkerReply {
  result: Record<string, unknown>;
  durationMs: number;
}
export interface RehearsalWorker {
  readonly port: number;
  command(command: string, fields?: Readonly<Record<string, unknown>>): Promise<WorkerReply>;
  close(): Promise<void>;
}
/** Child stdout/stderr are discarded: account claims and driver diagnostics never enter reports. */
export async function startRehearsalWorker(target: RuntimeFixture): Promise<RehearsalWorker> {
  await target.revalidate();
  const environment = runtimeChildEnvironment(target);
  const child = fork(new URL('../../packages/backend/src/__tests__/auth-rehearsal/worker.ts', import.meta.url), [], {
    execArgv: [
      '--import',
      createRequire(new URL('../../packages/backend/package.json', import.meta.url)).resolve('tsx'),
    ],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: environment,
  });
  let sequence = 0;
  const pending = new Map<
    number,
    { resolve(reply: WorkerReply): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();
  let readyResolve: (port: number) => void = () => {};
  let readyReject: (error: Error) => void = () => {};
  const ready = new Promise<number>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const readyTimer = setTimeout(() => {
    child.kill();
    readyReject(new RehearsalSafetyError('OWNED_WORKER_READY_TIMEOUT'));
  }, 20000);
  child.on('message', (candidate: unknown) => {
    if (!candidate || typeof candidate !== 'object') return;
    const message = candidate as Record<string, unknown>;
    if (message.type === 'ready' && typeof message.port === 'number' && message.port >= 1024 && message.port <= 65535) {
      clearTimeout(readyTimer);
      readyResolve(message.port);
    } else if (message.type === 'result' && typeof message.sequence === 'number') {
      const deferred = pending.get(message.sequence);
      if (!deferred) return;
      pending.delete(message.sequence);
      clearTimeout(deferred.timer);
      if (
        message.error ||
        !message.result ||
        typeof message.result !== 'object' ||
        typeof message.durationMs !== 'number'
      )
        deferred.reject(new RehearsalSafetyError('OWNED_WORKER_COMMAND_FAILED'));
      else deferred.resolve({ result: message.result as Record<string, unknown>, durationMs: message.durationMs });
    }
  });
  child.on('exit', () => {
    clearTimeout(readyTimer);
    readyReject(new RehearsalSafetyError('OWNED_WORKER_EXITED'));
    for (const deferred of pending.values()) {
      clearTimeout(deferred.timer);
      deferred.reject(new RehearsalSafetyError('OWNED_WORKER_EXITED'));
    }
    pending.clear();
  });
  child.send({
    type: 'initialize',
    runNonce: target.runNonce,
    networkNamespace: target.networkNamespace,
    marker: keyedReference(target.secrets.reportKey, `owned-auth-fixture:${target.runNonce}`),
  });
  const port = await ready;
  function command(commandName: string, fields: Readonly<Record<string, unknown>> = {}): Promise<WorkerReply> {
    const currentSequence = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(currentSequence);
        reject(new RehearsalSafetyError('OWNED_WORKER_COMMAND_TIMEOUT'));
      }, 15000);
      pending.set(currentSequence, { resolve, reject, timer });
      child.send({ ...fields, type: 'command', command: commandName, sequence: currentSequence });
    });
  }
  return {
    port,
    command,
    async close() {
      try {
        await command('close');
      } finally {
        if (child.exitCode === null) child.kill();
      }
    },
  };
}
