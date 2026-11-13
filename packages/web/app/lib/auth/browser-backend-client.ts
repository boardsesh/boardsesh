import { createBrowserBackendClient } from '@boardsesh/auth-protocol/browser-backend-client';
import { publicBrowserConsumersReady } from './browser-consumer-readiness';

export { createBrowserBackendClient } from '@boardsesh/auth-protocol/browser-backend-client';

export const browserBackendClient = createBrowserBackendClient({
  ready: publicBrowserConsumersReady,
  fetch: (...parameters) => fetch(...parameters),
  endpoint: '/api/internal/ws-auth',
  now: () => performance.now(),
  schedule(callback, milliseconds) {
    const timer = setTimeout(callback, milliseconds);
    return () => clearTimeout(timer);
  },
});
