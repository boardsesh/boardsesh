import { AsyncLocalStorage } from 'node:async_hooks';

/** SDK transport close aborts callbacks, but does not wait for their work. */
export class GymMcpRequestLifetime {
  private readonly pending = new Set<Promise<unknown>>();
  private closed = false;

  track<Result>(work: () => Promise<Result>): Promise<Result> {
    if (this.closed) return Promise.reject(new DOMException('The request was cancelled.', 'AbortError'));
    const pending = Promise.resolve().then(work);
    this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending)).catch(() => undefined);
    return pending;
  }

  async finish(): Promise<void> {
    // A callback scheduled by the SDK after transport close cannot start work.
    this.closed = true;
    await Promise.allSettled(this.pending);
  }
}

const requestLifetimes = new AsyncLocalStorage<GymMcpRequestLifetime>();

export function runWithGymMcpRequestLifetime<Result>(
  lifetime: GymMcpRequestLifetime,
  work: () => Promise<Result>,
): Promise<Result> {
  return requestLifetimes.run(lifetime, work);
}

export function trackGymMcpToolWork<Result>(work: () => Promise<Result>): Promise<Result> {
  return requestLifetimes.getStore()?.track(work) ?? work();
}
