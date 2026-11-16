import { browserHttpClients, getHttpClient, getOfflineSyncHttpClient } from './client.web';
import { createBrowserHttpOperations } from './http-operation-client.web';

export type { HttpOperationOptions } from './http-operation';

/** The supplied view is original caller intent. A missing/retired handle never
 * captures today's account while an earlier operation is awaiting work. */
const operations = createBrowserHttpOperations({
  captureScope: browserHttpClients.captureRequestView,
  isCurrentView: browserHttpClients.isCurrentView,
  captureResult: browserHttpClients.captureResult,
  resolveClient: (scope, mode) => (mode === 'offline' ? getOfflineSyncHttpClient(scope) : getHttpClient(scope)),
});

export const createHttpOperation = operations.create;

/** Capture before the first caller-owned await, including an unavailable
 * refusal marker. No request or credential acquisition happens here. */
export const captureHttpOperation = operations.capture;

export type HttpOperation = ReturnType<typeof createHttpOperation>;
