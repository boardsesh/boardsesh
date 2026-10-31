import { createInputTraceTransport } from './native-input-transport';
type NativeInputContext = {
  attemptId: string;
  interactionId: string;
  switchRowId?: string;
  parentId?: string;
  semanticRole?: string;
};
declare global {
  var __boardseshNativeInputAttemptId: string | undefined;
  var __boardseshNativeInputRawEvent:
    | ((stage: string, fields: Record<string, unknown>, handler?: object) => void)
    | undefined;
}
const enabled = typeof __DEV__ !== 'undefined' && __DEV__ && process.env.EXPO_PUBLIC_NATIVE_INPUT_TRACE === '1';
const runtimeId = String(Date.now());
const handlers = new WeakMap<object, { switchRowId: string; parentId?: string; semanticRole?: string }>();
let instanceSequence = 0,
  interactionSequence = 0;
let activeContext: NativeInputContext | undefined;
const transport =
  enabled && process.env.EXPO_PUBLIC_NATIVE_INPUT_TRACE_URL
    ? createInputTraceTransport({ runtimeId, url: process.env.EXPO_PUBLIC_NATIVE_INPUT_TRACE_URL })
    : undefined;
export function nativeInputInstanceId(component: string): string {
  return `${runtimeId}-${component}-${++instanceSequence}`;
}
export function nativeInputInteraction() {
  return activeContext;
}
export function nativeInputReadyUrl(url: string): string {
  if (!enabled) return url;
  try {
    const ready = new URL(url);
    ready.searchParams.set('runtimeId', runtimeId);
    return ready.toString();
  } catch {
    return url;
  }
}
export function traceNativeInput(stage: string, fields: Record<string, unknown> = {}): void {
  if (!enabled) return;
  // Everything in this try is diagnostic-only. Real haptics and callbacks stay outside it.
  try {
    const event = {
      timestamp: new Date().toISOString(),
      runtimeId,
      attemptId: globalThis.__boardseshNativeInputAttemptId ?? 'instrumented-unassigned',
      ...activeContext,
      stage,
      ...fields,
    };
    transport?.emit(event);
    console.info('[native-input]', JSON.stringify(event));
  } catch {
    transport?.emit({ stage: 'diagnostic-serialization-failed' });
  }
}
export function registerNativeInputHandler(
  handler: object,
  instanceId: string,
  parentId?: string,
  semanticRole?: string,
): void {
  if (enabled) handlers.set(handler, { switchRowId: instanceId, parentId, semanticRole });
}
export function startNativeInputHeartbeat(parentId: string): () => void {
  try {
    transport?.startHeartbeat(() => ({ componentId: parentId, parentId, semanticRole: 'session-visibility' }));
  } catch {
    /* diagnostic transport only */
  }
  return () => {
    try {
      transport?.close();
    } catch {
      /* diagnostic cleanup only */
    }
  };
}
if (enabled)
  globalThis.__boardseshNativeInputRawEvent = (stage, fields, handler) => {
    // Catch only diagnostic bookkeeping; never wrap the real wrapper callback.
    try {
      if (stage === 'raw-wrapper')
        activeContext = {
          attemptId: globalThis.__boardseshNativeInputAttemptId ?? `${runtimeId}-maestro-${interactionSequence + 1}`,
          interactionId: `input-${++interactionSequence}`,
          ...(handler ? handlers.get(handler) : undefined),
        };
      traceNativeInput(stage, fields);
    } catch {
      transport?.emit({ stage: 'diagnostic-serialization-failed' });
    }
  };
