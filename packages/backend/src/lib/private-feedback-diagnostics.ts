import type { Event, NodeOptions } from '@sentry/node';
import { redactOriginProof } from '@boardsesh/consent/origin-proof';

export function isBoardRequestDocument(document: string): boolean {
  return document.includes('submitBoardRequest');
}

export function isAdminFeedbackDocument(document: string): boolean {
  return document.includes('adminAppFeedback');
}

export function isPrivateFeedbackDocument(document: string): boolean {
  return isBoardRequestDocument(document) || isAdminFeedbackDocument(document);
}

export function isPrivateFeedbackGet(method: string | undefined, url: URL, query = url.searchParams): boolean {
  return method === 'GET' && url.pathname === '/graphql' && query.getAll('query').some(isPrivateFeedbackDocument);
}

function isPrivateFeedbackHttpEvent(event: Event): boolean {
  const request = event.request;
  const attributes = event.contexts?.trace?.data;
  const method = request?.method ?? attributes?.['http.request.method'] ?? attributes?.['http.method'];
  if (method !== 'GET') return false;
  const query = new URLSearchParams(request?.query_string);
  return [
    request?.url,
    attributes?.['url.full'],
    attributes?.['http.url'],
    attributes?.['http.target'],
    attributes?.['url.path'],
  ].some((target) => {
    if (typeof target !== 'string') return false;
    const url = URL.parse(target, 'http://localhost');
    return url !== null && (isPrivateFeedbackGet(method, url) || isPrivateFeedbackGet(method, url, query));
  });
}

// Node's HTTP integration records GET parameters before Yoga sees the operation.
// Keep a countable, fixed diagnostic without copying the request, spans or headers.
export const privateFeedbackDiagnosticHooks: Pick<
  NodeOptions,
  'beforeSend' | 'beforeSendTransaction' | 'beforeSendSpan'
> = {
  beforeSend(event) {
    if (!isPrivateFeedbackHttpEvent(event)) return redactOriginProof(event);
    return {
      type: event.type,
      event_id: event.event_id,
      level: event.level,
      message: 'Private feedback HTTP request failed',
    };
  },
  beforeSendTransaction(event) {
    return isPrivateFeedbackHttpEvent(event) ? null : redactOriginProof(event);
  },
  // Custom headers also reach independently streamed spans with PII disabled.
  beforeSendSpan: redactOriginProof,
};
