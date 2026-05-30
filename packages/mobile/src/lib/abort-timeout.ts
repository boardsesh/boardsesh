// Hermes on RN 0.85 supports AbortSignal.timeout, but a future RN baseline
// or any alternate runtime without it would make every fetch in this file
// throw silently (the swallowing catch blocks turn that into "no servers
// found" with no log). Using AbortController + setTimeout keeps the same
// shape on every JS runtime.
export function createTimeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  return controller.signal;
}

// Returns a signal that aborts as soon as any of the source signals abort.
// `AbortSignal.any` exists on modern runtimes but not on every Hermes pin —
// reimplement to stay portable.
export function combineAbortSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

// Maps `items` through `fn` with at most `concurrency` calls in flight at a
// time. Preserves input order in the returned array. Used to keep the Metro
// discovery scan from saturating the network stack on multi-host tailnets.
//
// Error semantics: if any `fn` call rejects, sibling workers keep draining
// so in-flight calls finish cleanly, and the first error is re-thrown once
// all workers have settled. This matches `Promise.all`'s "first error wins"
// shape.
//
// CAVEAT: on the throw path the returned `results` is internal-only — slots
// for rejected items were never assigned, so the array is sparse (`R[]`
// with `undefined` holes). The function throws before any caller can
// observe it, but callers must not catch and then read `results` from a
// caller-side reference: there isn't one, the variable is local. If you
// ever expose partial results, return a tagged `{ values, errors }` shape
// instead.
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  // Array (not a `let`) so TS doesn't narrow the value past the closure
  // mutation — and so we can distinguish "no error" from "first error was
  // literally undefined".
  const collectedErrors: unknown[] = [];

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index]);
      } catch (err) {
        if (collectedErrors.length === 0) collectedErrors.push(err);
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker);
  await Promise.all(workers);
  if (collectedErrors.length > 0) throw collectedErrors[0];
  return results;
}
