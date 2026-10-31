type NativeInputContext = {
  attemptId: string;
  interactionId: string;
  switchRowId?: string;
};

declare global {
  var __boardseshNativeInputAttemptId: string | undefined;
  var __boardseshNativeInputRawEvent:
    | ((stage: string, fields: Record<string, unknown>, handler?: object) => void)
    | undefined;
}

const enabled = typeof __DEV__ !== 'undefined' && __DEV__ && process.env.EXPO_PUBLIC_NATIVE_INPUT_TRACE === '1';
const runtimeId = String(Date.now());
const handlers = new WeakMap<object, string>();
let instanceSequence = 0;
let interactionSequence = 0;
let activeContext: NativeInputContext | undefined;

export function nativeInputInstanceId(component: string): string {
  return `${runtimeId}-${component}-${++instanceSequence}`;
}

export function nativeInputInteraction(): NativeInputContext | undefined {
  return activeContext;
}

export function traceNativeInput(stage: string, fields: Record<string, unknown> = {}): void {
  if (!enabled) return;
  console.info(
    '[native-input]',
    JSON.stringify({
      timestamp: new Date().toISOString(),
      runtimeId,
      attemptId: globalThis.__boardseshNativeInputAttemptId ?? 'instrumented-unassigned',
      ...activeContext,
      stage,
      ...fields,
    }),
  );
}

export function registerNativeInputHandler(handler: object, instanceId: string): void {
  if (enabled) handlers.set(handler, instanceId);
}

if (enabled) {
  globalThis.__boardseshNativeInputRawEvent = (stage, fields, handler) => {
    if (stage === 'raw-wrapper') {
      activeContext = {
        attemptId: globalThis.__boardseshNativeInputAttemptId ?? `${runtimeId}-maestro-${interactionSequence + 1}`,
        interactionId: `input-${++interactionSequence}`,
        switchRowId: handler ? handlers.get(handler) : undefined,
      };
    }
    traceNativeInput(stage, fields);
  };
}
