import { GraphQLClient } from 'graphql-request';
import { createAbortError } from './request-timeout';

/** Keep the installed SDK's request overloads and decoded objects. Only signal
 * composition and the original invocation's delivery admission are added. */
export function createHttpOperationRequest(options: {
  readonly resolveClient: () => GraphQLClient;
  readonly beginRequest: () => Readonly<{ admit: (result: unknown) => void; discard: () => void }>;
  readonly signal: AbortSignal;
}): GraphQLClient['request'] {
  const { resolveClient, beginRequest, signal } = options;
  // The prototype target retains the SDK overloads; the trap always invokes
  // the actual operation client with its own bound receiver below.
  return new Proxy(GraphQLClient.prototype.request.bind(GraphQLClient.prototype), {
    async apply(_target, _receiver, parameters: unknown[]) {
      const assertActive = (candidate: AbortSignal) => {
        if (candidate.aborted) throw candidate.reason ?? createAbortError('GraphQL operation aborted');
      };
      assertActive(signal);
      const pending = beginRequest();
      try {
        const first = parameters[0];
        // The SDK accepts either RequestOptions or document/variables/headers.
        // Convert only that public shape so disposal reaches real decoding too.
        const requestOptions =
          first !== null && typeof first === 'object' && 'document' in first
            ? { ...first }
            : { document: first, variables: parameters[1], requestHeaders: parameters[2] };
        const caller = 'signal' in requestOptions ? (requestOptions.signal as AbortSignal | null | undefined) : null;
        const requestSignal = caller ? AbortSignal.any([caller, signal]) : signal;
        assertActive(requestSignal);
        const client = resolveClient();
        assertActive(requestSignal);
        const execute = client.request.bind(client);
        const result: unknown = await Reflect.apply(execute, undefined, [{ ...requestOptions, signal: requestSignal }]);
        assertActive(requestSignal);
        pending.admit(result);
        assertActive(requestSignal);
        return result;
      } finally {
        pending.discard();
      }
    },
  });
}
