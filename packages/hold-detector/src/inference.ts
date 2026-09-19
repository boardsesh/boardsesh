import { Worker } from 'node:worker_threads';
import type { DetectResult } from './detect';
import type { LoadModelOptions } from './model';

type Reply = { type: 'ready' } | { type: 'result'; result: DetectResult } | { type: 'failed' };

/** One warm model; terminating the thread also stops a timed-out native inference. */
export class InferenceRunner {
  private worker: Worker | null = null;
  private active = false;
  constructor(private readonly options: Omit<LoadModelOptions, 'fetchImpl'> & { weightsSha256: string }) {}

  get ready(): boolean {
    return this.worker !== null;
  }

  async start(timeoutMs = 120_000): Promise<void> {
    if (this.worker) return;
    const worker = new Worker(new URL('./inference-bootstrap.mjs', import.meta.url), {
      workerData: this.options,
      execArgv: [],
    });
    this.worker = worker;
    // Keep listeners even between jobs: an idle native crash must not become
    // an unhandled EventEmitter error or leave a dead worker marked healthy.
    const clearWorker = () => {
      if (this.worker === worker) this.worker = null;
    };
    worker.on('error', clearWorker);
    worker.once('exit', clearWorker);
    await this.waitFor(worker, timeoutMs, 'ready');
  }

  private waitFor(worker: Worker, timeoutMs: number, expected: 'ready' | 'result'): Promise<DetectResult | undefined> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
      };
      const fail = () => {
        cleanup();
        if (this.worker === worker) this.worker = null;
        void worker.terminate();
        reject(new Error('INFERENCE_FAILED'));
      };
      const onError = () => fail();
      const onExit = () => fail();
      const onMessage = (reply: Reply) => {
        if (reply.type !== expected) {
          fail();
          return;
        }
        cleanup();
        resolve(reply.type === 'result' ? reply.result : undefined);
      };
      const timer = setTimeout(fail, timeoutMs);
      worker.on('message', onMessage);
      worker.once('error', onError);
      worker.once('exit', onExit);
    });
  }

  async run(photo: Buffer): Promise<DetectResult> {
    if (this.active) throw new Error('INFERENCE_BUSY');
    this.active = true;
    const deadline = Date.now() + 90_000;
    try {
      await this.start(90_000);
      const worker = this.worker;
      if (!worker) throw new Error('INFERENCE_NOT_READY');
      const response = this.waitFor(worker, Math.max(1, deadline - Date.now()), 'result');
      worker.postMessage(photo);
      const result = await response;
      if (!result) throw new Error('INFERENCE_EMPTY_RESULT');
      return result;
    } finally {
      this.active = false;
    }
  }

  async stop(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate();
  }
}
