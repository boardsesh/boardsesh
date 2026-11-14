import { BrowserBackendConsumerError } from './browser-backend-consumer';

export const BROWSER_HTTP_VIEW_PREFIX = 'bshv1_';
export type BrowserHttpViewKind = 'selected' | 'legacy' | 'anonymous';
export type BrowserHttpView = {
  /** Process-private comparison only. Never returned as the public handle. */
  readonly key: string;
  readonly kind: BrowserHttpViewKind;
  readonly isCurrent: () => boolean;
};
export type BrowserHttpViewClient<Client> = {
  readonly client: Client;
  readonly isCurrent: () => boolean;
  readonly isCurrentResult: (result: unknown) => boolean;
  readonly captureResult?: (result: unknown) => (() => void) | null;
  readonly dispose: () => void;
};

/** Noncredential query labels locate only an original in-memory view. A label
 * supplies no source proof, and an unknown label never chooses today's client.
 * The injected transport still independently requires its actual issued lease. */
export function createBrowserBackendHttpViewRegistry<Client>(options: {
  /** Fresh random nonce for this registry lifetime. Never reuse a namespace
   * when recreating a registry; old serialized labels must remain unknown. */
  readonly namespace: string;
  readonly capture: () => BrowserHttpView;
  readonly create: (view: BrowserHttpView) => BrowserHttpViewClient<Client>;
}) {
  const { namespace, capture, create } = options;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(namespace)) throw new BrowserBackendConsumerError('unavailable');
  type Entry = { readonly view: BrowserHttpView; readonly transport: BrowserHttpViewClient<Client> };
  const entries = new Map<string, Entry>();
  let sequence = 0;
  let closed = false;
  const current = (entry: Entry) => {
    try {
      return !closed && entry.view.isCurrent() && entry.transport.isCurrent();
    } catch {
      return false;
    }
  };
  const remove = (handle: string, entry: Entry) => {
    entries.delete(handle);
    try {
      entry.transport.dispose();
    } catch {
      // One transport cannot keep another retired view reachable.
    }
  };
  const requireEntry = (handle: string): Entry => {
    const entry = entries.get(handle);
    if (!entry || !current(entry)) {
      if (entry) remove(handle, entry);
      throw new BrowserBackendConsumerError('superseded');
    }
    return entry;
  };
  return Object.freeze({
    capture(): string {
      if (closed) throw new BrowserBackendConsumerError('unavailable');
      // Capture original intent before creating a client or awaiting a lease.
      const captured = capture();
      const view = Object.freeze({ key: captured.key, kind: captured.kind, isCurrent: captured.isCurrent });
      if (!view.key || !view.isCurrent()) throw new BrowserBackendConsumerError('unavailable');
      for (const [handle, entry] of entries) {
        if (!current(entry)) remove(handle, entry);
        else if (entry.view.key === view.key && entry.view.kind === view.kind) return handle;
      }
      while (entries.size >= 64) {
        const [handle, entry] = entries.entries().next().value!;
        remove(handle, entry);
      }
      if (!Number.isSafeInteger(sequence + 1)) throw new BrowserBackendConsumerError('unavailable');
      const transport = create(view);
      const handle = `${BROWSER_HTTP_VIEW_PREFIX}${namespace}_${++sequence}`;
      const entry = { view, transport };
      if (!current(entry)) {
        transport.dispose();
        throw new BrowserBackendConsumerError('superseded');
      }
      entries.set(handle, entry);
      return handle;
    },
    resolve(handle: string): Client {
      return requireEntry(handle).transport.client;
    },
    kind(handle: string): BrowserHttpViewKind {
      return requireEntry(handle).view.kind;
    },
    isCurrent(handle: string): boolean {
      try {
        requireEntry(handle);
        return true;
      } catch {
        return false;
      }
    },
    isCurrentResult(handle: string, result: unknown): boolean {
      try {
        return requireEntry(handle).transport.isCurrentResult(result);
      } catch {
        return false;
      }
    },
    captureResult(handle: string, result: unknown): (() => void) | null {
      try {
        const entry = requireEntry(handle);
        const assertResult = entry.transport.captureResult?.(result);
        if (!assertResult) return null;
        assertResult();
        return () => {
          if (requireEntry(handle) !== entry) throw new BrowserBackendConsumerError('superseded');
          assertResult();
        };
      } catch {
        return null;
      }
    },
    /** Clear local clients only. This never changes the actual source
     * authority, restores anonymous access or reuses a retired handle. */
    clear(): void {
      for (const [handle, entry] of entries) remove(handle, entry);
    },
    dispose(): void {
      if (closed) return;
      closed = true;
      for (const [handle, entry] of entries) remove(handle, entry);
    },
  });
}
