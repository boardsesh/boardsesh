import { captureAuthCredentialGeneration, getAuthToken, isAuthCredentialGenerationCurrent } from '../auth-store.web';
import { ensureFreshToken, recoverAuthRejection } from '../auth-interceptor.web';
import { createWsClientModule } from './ws-client-core';

const { getWsClient, disposeWsClient } = createWsClientModule({
  // Browsers only support the standard two-argument WebSocket constructor. The
  // native client has a separate fork that suppresses its Origin header.
  createSocket: (url, protocols) => new WebSocket(url, protocols),
  captureAuthCredentialGeneration,
  getAuthToken,
  isAuthCredentialGenerationCurrent,
  ensureFreshToken,
  recoverAuthRejection,
});

export { getWsClient, disposeWsClient };
