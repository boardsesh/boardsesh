import {
  BROWSER_COORDINATOR_LOCK,
  BROWSER_COORDINATOR_FRAME_PATH,
  BROWSER_COORDINATOR_PUBLIC_PATHS,
  browserCoordinatorObservationSchema,
  requireCoordinatorOrigin,
} from './browser-coordinator-v1';
import {
  connectBrowserCoordinatorClient,
  createBrowserCoordinatorEndpoint,
  type CoordinatorClientPlatform,
  type CoordinatorPort,
  type BrowserCoordinatorClient,
} from './browser-coordinator-channel';
import { createBrowserCoordinatorRunner, type CoordinatorRequestContext } from './browser-coordinator-runner';

/** Browser-only platform I/O shared by www and Expo web; no React or storage. */
export function browserCoordinatorPort(port: MessagePort): CoordinatorPort {
  return {
    post: (message) => port.postMessage(message),
    listen(message, disconnected) {
      const receive = (event: MessageEvent<unknown>) => message(event.data);
      port.addEventListener('message', receive);
      port.addEventListener('messageerror', disconnected);
      port.start();
      return () => {
        port.removeEventListener('message', receive);
        port.removeEventListener('messageerror', disconnected);
      };
    },
    close: () => port.close(),
  };
}
function schedule(callback: () => void, milliseconds: number) {
  const timer = setTimeout(callback, milliseconds);
  return () => clearTimeout(timer);
}
export function browserCoordinatorDomPlatform(): CoordinatorClientPlatform {
  return {
    createChannel() {
      const channel = new MessageChannel();
      return { local: browserCoordinatorPort(channel.port1), remote: channel.port2 };
    },
    postConnect(target, exactOrigin, message, remote) {
      (target as Window).postMessage(message, exactOrigin, [remote as MessagePort]);
    },
    newId: () => crypto.randomUUID(),
    schedule,
  };
}

/** Caller owns the iframe/window lifetime. Reconnect always performs a primary
 * read before exposing a usable client, never initializes merely to reconnect. */
export async function connectCanonicalBrowserCoordinator(options: {
  readonly canonicalOrigin: string;
  readonly target: Window;
  readonly signal?: AbortSignal;
}) {
  const client = await connectBrowserCoordinatorClient({
    canonicalOrigin: options.canonicalOrigin,
    target: options.target,
    platform: browserCoordinatorDomPlatform(),
    timeoutMs: 15_000,
  });
  const observed = await client.request({ operation: 'read' }, options.signal);
  if (observed.status !== 'ready' || options.signal?.aborted) {
    client.close();
    throw new Error('COORDINATOR_UNAVAILABLE');
  }
  return client;
}

/** One retained frame per document lifetime. A cancelled metadata request does
 * not remove the host while its actual cookie fetch may still be settling. */
export function createCanonicalBrowserCoordinatorFrame(options: {
  readonly window: Window;
  readonly canonicalOrigin: string;
}) {
  const canonicalOrigin = requireCoordinatorOrigin(options.canonicalOrigin);
  const owner = options.window;
  const frame = owner.document.createElement('iframe');
  frame.hidden = true;
  frame.setAttribute('aria-hidden', 'true');
  frame.referrerPolicy = 'no-referrer';
  frame.src = new URL(BROWSER_COORDINATOR_FRAME_PATH, canonicalOrigin).href;
  let closed = false;
  let client: BrowserCoordinatorClient | null = null;
  let connecting: Promise<BrowserCoordinatorClient> | null = null;
  let stopLoading = () => {};
  const loaded = new Promise<Window>((resolve, reject) => {
    const fail = () => reject(new Error('COORDINATOR_UNAVAILABLE'));
    const load = () => (frame.contentWindow ? resolve(frame.contentWindow) : fail());
    const cancelTimeout = schedule(fail, 15_000);
    frame.addEventListener('load', load, { once: true });
    frame.addEventListener('error', fail, { once: true });
    stopLoading = () => {
      cancelTimeout();
      frame.removeEventListener('load', load);
      frame.removeEventListener('error', fail);
      fail();
    };
  });
  // A document may close before its first caller consumes the load promise.
  void loaded.catch(() => {});
  owner.document.body.append(frame);
  const close = () => {
    if (closed) return;
    closed = true;
    owner.removeEventListener('pagehide', close);
    stopLoading();
    client?.close();
    frame.remove();
  };
  owner.addEventListener('pagehide', close);
  return {
    isClosed: () => closed,
    close,
    async read(signal?: AbortSignal) {
      if (closed || signal?.aborted) return { status: 'unavailable' } as const;
      try {
        if (!client || client.isClosed()) {
          connecting ??= loaded.then((target) => {
            if (closed) throw new Error('COORDINATOR_UNAVAILABLE');
            return connectBrowserCoordinatorClient({
              canonicalOrigin,
              target,
              platform: browserCoordinatorDomPlatform(),
              timeoutMs: 15_000,
            });
          });
          try {
            client = await connecting;
            if (closed) {
              client.close();
              return { status: 'unavailable' } as const;
            }
          } finally {
            connecting = null;
          }
        }
        return await client.request({ operation: 'read' }, signal);
      } catch {
        return { status: 'unavailable' } as const;
      }
    },
  };
}

async function metadata(response: Response, context: CoordinatorRequestContext) {
  if (
    ![200, 409, 503].includes(response.status) ||
    !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')
  )
    throw new Error('COORDINATOR_UNAVAILABLE');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('COORDINATOR_UNAVAILABLE');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (context.signal.aborted) throw new Error('COORDINATOR_UNAVAILABLE');
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 8_192) throw new Error('COORDINATOR_UNAVAILABLE');
      chunks.push(chunk.value);
    }
    const joined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const result = browserCoordinatorObservationSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined)),
    );
    if (
      response.status !== 200 &&
      result.status !== 'conflict' &&
      result.status !== 'proof-required' &&
      result.status !== 'unavailable'
    )
      throw new Error('COORDINATOR_UNAVAILABLE');
    return result;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Only the canonical origin executes network work. Its real navigator.locks
 * lock remains held through fetch AND body settlement, including cancellation. */
export function mountCanonicalBrowserCoordinator(options: {
  readonly window: Window;
  readonly canonicalOrigin: string;
  readonly peers: readonly { readonly origin: string; readonly source: Window }[];
  readonly fetch?: typeof fetch;
}) {
  const canonicalOrigin = requireCoordinatorOrigin(options.canonicalOrigin);
  const owner = options.window;
  if (owner.location.origin !== canonicalOrigin || !owner.navigator.locks) throw new Error('COORDINATOR_UNAVAILABLE');
  const send = options.fetch ?? owner.fetch.bind(owner);
  const request = (operation: keyof typeof BROWSER_COORDINATOR_PUBLIC_PATHS, context: CoordinatorRequestContext) =>
    send(new URL(BROWSER_COORDINATOR_PUBLIC_PATHS[operation], canonicalOrigin), {
      method: operation === 'observe' ? 'GET' : 'POST',
      credentials: context.credentials,
      cache: context.cache,
      keepalive: context.keepalive,
      redirect: 'error',
      signal: context.signal,
      ...(operation === 'initialize' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}),
    });
  const run = createBrowserCoordinatorRunner({
    withExclusiveLock: (operation, signal) =>
      owner.navigator.locks.request(BROWSER_COORDINATOR_LOCK, { mode: 'exclusive', signal }, operation),
    schedule,
    timeoutMs: 15_000,
    transport: {
      observe: async (context) => metadata(await request('observe', context), context),
      initialize: async (context) => {
        const result = await metadata(await request('initialize', context), context);
        if (result.status !== 'ready') throw new Error('COORDINATOR_UNAVAILABLE');
      },
      // Mutating prepare and rolling renewal await their separate issuer/CAS
      // composition; absent commands remain unavailable rather than succeeding.
    },
  });
  const endpoint = createBrowserCoordinatorEndpoint({ peers: options.peers, run });
  const receive = (event: MessageEvent<unknown>) =>
    endpoint.receive({
      origin: event.origin,
      source: event.source,
      message: event.data,
      ports: [...event.ports].map(browserCoordinatorPort),
    });
  const close = () => {
    owner.removeEventListener('message', receive);
    owner.removeEventListener('pagehide', close);
    endpoint.close();
  };
  owner.addEventListener('message', receive);
  owner.addEventListener('pagehide', close);
  return { close };
}
