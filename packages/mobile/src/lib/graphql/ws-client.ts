import { captureAuthCredentialGeneration, getAuthToken, isAuthCredentialGenerationCurrent } from '../auth-store';
import { ensureFreshToken, recoverAuthRejection } from '../auth-interceptor';
import { createWsClientModule } from './ws-client-core';
import { assertNetworkAllowed, isNetworkAllowed, subscribeNetworkPolicy } from '../network-policy';

// React Native's WebSocket derives an `Origin` header from the JS bundle
// URL (e.g. `http://localhost:8084` in dev). The backend's `verifyClient`
// (packages/backend/src/handlers/cors.ts:140-149) rejects any Origin not
// on the allowlist with HTTP 403, killing the upgrade before any GraphQL
// op can run. The same handler intentionally allows requests with no
// Origin header so native apps can connect — RN just doesn't take that
// branch by default. Pass an empty `origin` via RN's 3rd-arg options to
// drop the header. The DOM `WebSocket` type doesn't expose this arg, so
// cast through a local alias.
type RNWebSocketCtor = new (
  url: string | URL,
  protocols?: string | string[],
  options?: { headers?: Record<string, string> },
) => WebSocket;

const wsClientModule = createWsClientModule({
  createSocket: (url, protocols) => {
    const ReactNativeWebSocket = WebSocket as unknown as RNWebSocketCtor;
    return new ReactNativeWebSocket(url, protocols, { headers: { origin: '' } });
  },
  captureAuthCredentialGeneration,
  getAuthToken,
  isAuthCredentialGenerationCurrent,
  ensureFreshToken,
  recoverAuthRejection,
});

function getWsClient() {
  assertNetworkAllowed('backend');
  return wsClientModule.getWsClient();
}

function disposeWsClient(): void {
  wsClientModule.disposeWsClient();
}

subscribeNetworkPolicy(() => {
  if (!isNetworkAllowed('backend')) disposeWsClient();
});

export { getWsClient, disposeWsClient };
