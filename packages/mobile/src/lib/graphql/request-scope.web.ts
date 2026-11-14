import { browserHttpClients } from './client.web';

export const captureHttpRequestScope = browserHttpClients.captureRequestView;
export const assertCurrentHttpResult = browserHttpClients.assertCurrentResult;
export const isCurrentHttpView = browserHttpClients.isCurrentView;
export const httpScopeQueryKey = browserHttpClients.queryKey;
