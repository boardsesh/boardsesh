import { BrowserBackendConsumerError } from '@boardsesh/auth-protocol/browser-backend-consumer';
import { GraphQLClient } from 'graphql-request';
import { createAbortError } from './request-timeout';

type DispatchVeto = Readonly<{ assertCurrent: () => void; close: () => void }>;
// Only actual invocation signals can locate a veto. Closed weak aliases remain
// refusal tombstones while a timed-out acquisition can still resume.
const dispatchVetos = new WeakMap<AbortSignal, DispatchVeto>();
function registerDispatchVeto(signal: AbortSignal, original: () => void): DispatchVeto {
  let callback: (() => void) | undefined = original;
  const record = Object.freeze({
    assertCurrent() {
      if (!callback) throw new BrowserBackendConsumerError('superseded');
      callback();
    },
    close() {
      callback = undefined;
    },
  });
  if (dispatchVetos.has(signal)) throw new BrowserBackendConsumerError('superseded');
  dispatchVetos.set(signal, record);
  return record;
}
export function captureHttpOperationDispatchVeto(signal: AbortSignal | null | undefined): (() => void) | undefined {
  return signal ? dispatchVetos.get(signal)?.assertCurrent : undefined;
}
export function inheritHttpOperationDispatchVeto(
  source: AbortSignal | null | undefined,
  derived: AbortSignal,
): AbortSignal {
  const record = source ? dispatchVetos.get(source) : undefined;
  if (!record) return derived;
  const existing = dispatchVetos.get(derived);
  if (existing && existing !== record) throw new BrowserBackendConsumerError('superseded');
  dispatchVetos.set(derived, record);
  return derived;
}

/** Keep the installed SDK's request overloads and decoded objects. Only signal
 * composition and the original invocation's delivery admission are added. */
export function createHttpOperationRequest(options: {
  readonly resolveClient: () => GraphQLClient;
  readonly beginRequest: (
    requestIdentity: AbortSignal,
  ) => Readonly<{ admit: (result: unknown) => void; admitError: (error: unknown) => void; discard: () => void }>;
  readonly signal: AbortSignal;
  readonly assertDispatch?: () => void;
}): GraphQLClient['request'] {
  const { resolveClient, beginRequest, signal, assertDispatch } = options;
  // The prototype target retains the SDK overloads; the trap always invokes
  // the actual operation client with its own bound receiver below.
  return new Proxy(GraphQLClient.prototype.request.bind(GraphQLClient.prototype), {
    async apply(_target, _receiver, parameters: unknown[]) {
      const assertActive = (candidate: AbortSignal) => {
        if (candidate.aborted) throw candidate.reason ?? createAbortError('GraphQL operation aborted');
      };
      assertActive(signal);
      let pending: ReturnType<typeof beginRequest> | undefined;
      let dispatchVeto: DispatchVeto | undefined;
      try {
        const first = parameters[0];
        // The SDK accepts either RequestOptions or document/variables/headers.
        // Convert only that public shape so disposal reaches real decoding too.
        const requestOptions =
          first !== null && typeof first === 'object' && 'document' in first
            ? { ...first }
            : { document: first, variables: parameters[1], requestHeaders: parameters[2] };
        const caller = 'signal' in requestOptions ? (requestOptions.signal as AbortSignal | null | undefined) : null;
        // A distinct identity for every invocation, even without caller signal.
        const requestSignal = AbortSignal.any(caller ? [caller, signal] : [signal]);
        if (assertDispatch) dispatchVeto = registerDispatchVeto(requestSignal, assertDispatch);
        pending = beginRequest(requestSignal);
        assertActive(requestSignal);
        const client = resolveClient();
        assertActive(requestSignal);
        const execute = client.request.bind(client);
        const result: unknown = await Reflect.apply(execute, undefined, [{ ...requestOptions, signal: requestSignal }]);
        assertActive(requestSignal);
        pending.admit(result);
        assertActive(requestSignal);
        return result;
      } catch (error) {
        pending?.admitError(error);
        throw error;
      } finally {
        try {
          pending?.discard();
        } finally {
          dispatchVeto?.close();
        }
      }
    },
  });
}
