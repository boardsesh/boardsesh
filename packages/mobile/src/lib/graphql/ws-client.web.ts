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
  // Expo web draws no offline-mode row and persists no setting behind one, so
  // there is nothing here for the gate to read.
  isOfflineModeOn: () => false,
});

export { getWsClient, disposeWsClient };
