import { WEB_ORIGIN_HEADER } from '../web-origin';

function stripOriginAttributes(attributes: Record<string, unknown> | undefined): void {
  if (!attributes) return;
  for (const key of Object.keys(attributes)) {
    if (key.toLowerCase().replaceAll('_', '-').endsWith(WEB_ORIGIN_HEADER)) delete attributes[key];
  }
}

/** Sentry captures incoming headers before middleware constructs its routing view. */
export function redactWebOriginEvent<
  Event extends {
    request?: { headers?: Record<string, string> };
    contexts?: { trace?: { data?: Record<string, unknown> } };
    spans?: Array<{ data?: Record<string, unknown> }>;
  },
>(event: Event): Event {
  stripOriginAttributes(event.request?.headers);
  stripOriginAttributes(event.contexts?.trace?.data);
  for (const span of event.spans ?? []) stripOriginAttributes(span.data);
  return event;
}

export function redactWebOriginSpan<Span extends { data?: Record<string, unknown> }>(span: Span): Span {
  stripOriginAttributes(span.data);
  return span;
}

export function redactWebOriginLog<Log extends { attributes?: Record<string, unknown> }>(log: Log): Log {
  stripOriginAttributes(log.attributes);
  return log;
}
