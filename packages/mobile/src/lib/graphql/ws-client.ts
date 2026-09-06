import { captureAuthCredentialGeneration, getAuthToken, isAuthCredentialGenerationCurrent } from '../auth-store';
import { ensureFreshToken, recoverAuthRejection } from '../auth-interceptor';
import { getConnectivitySnapshot } from '../connectivity/connectivity-store';
import { createWsClientModule } from './ws-client-core';

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

const { getWsClient, disposeWsClient } = createWsClientModule({
  createSocket: (url, protocols) => {
    const ReactNativeWebSocket = WebSocket as unknown as RNWebSocketCtor;
    return new ReactNativeWebSocket(url, protocols, { headers: { origin: '' } });
  },
  captureAuthCredentialGeneration,
  getAuthToken,
  isAuthCredentialGenerationCurrent,
  ensureFreshToken,
  recoverAuthRejection,
  // The store is pure TypeScript with no react-native in its graph, so reading
  // it here costs this module nothing it did not already carry.
  isOfflineModeOn: () => getConnectivitySnapshot().offlineMode,
});

export { getWsClient, disposeWsClient };
