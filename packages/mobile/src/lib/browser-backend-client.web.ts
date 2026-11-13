import { createBrowserBackendClient } from '@boardsesh/auth-protocol/browser-backend-client';
import { webApiUrl } from './env';
import { publicExpoBrowserConsumersReady } from './browser-consumer-readiness.web';

/** Host-only source proof stays at canonical WWW. The app receives only a short
 * backend lease; nothing from this client is persisted or broadcast. */
export const expoBrowserBackendClient = createBrowserBackendClient({
  ready: publicExpoBrowserConsumersReady,
  fetch: (...parameters) => fetch(...parameters),
  endpoint: webApiUrl('/api/internal/ws-auth'),
  now: () => performance.now(),
  schedule(callback, milliseconds) {
    const timer = setTimeout(callback, milliseconds);
    return () => clearTimeout(timer);
  },
});
