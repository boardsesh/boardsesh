import type { CncBoardConfigInput } from '@boardsesh/shared-schema';
import {
  GET_CNC_COMPUTATION,
  REQUEST_CNC_ARTWORK_VALIDATION,
  REQUEST_CNC_LAYOUT,
  type CncComputationResult,
} from '@boardsesh/graphql/operations/cnc-packs';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';

function computationFailure(errorCode?: string | null): Error {
  const unavailable = !errorCode || errorCode === 'CNC_WORKER_UNAVAILABLE' || errorCode.startsWith('GENERATOR_');
  const code = unavailable ? 'CNC_WORKER_UNAVAILABLE' : 'CNC_INVALID_CONFIG';
  return Object.assign(new Error(code), { response: { errors: [{ extensions: { code } }] } });
}

function delay(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, 1_000);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Each network request is short. Polling stops on config/account changes or after 90 seconds. */
export async function computeCnc(
  operation: 'layout' | 'artwork',
  config: CncBoardConfigInput,
  options: {
    includeHoles?: boolean;
    authToken?: string | null;
    signal: AbortSignal;
    isCurrent?: () => boolean;
  },
): Promise<Record<string, unknown>> {
  const assertCurrent = () => {
    if (options.isCurrent && !options.isCurrent()) throw new Error('STALE_CNC_REQUEST');
  };
  assertCurrent();
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(90_000)]);
  const client = createGraphQLHttpClient(options.authToken);
  const submitted =
    operation === 'layout'
      ? await client.request<{ requestCncLayout: CncComputationResult }>({
          document: REQUEST_CNC_LAYOUT,
          variables: { config, includeHoles: options.includeHoles ?? false },
          signal,
        })
      : await client.request<{ requestCncArtworkValidation: CncComputationResult }>({
          document: REQUEST_CNC_ARTWORK_VALIDATION,
          variables: { config },
          signal,
        });
  assertCurrent();
  let computation =
    'requestCncLayout' in submitted ? submitted.requestCncLayout : submitted.requestCncArtworkValidation;
  while (true) {
    signal.throwIfAborted();
    assertCurrent();
    if (computation.status === 'ready') {
      if (!computation.result) throw computationFailure();
      return computation.result;
    }
    if (computation.status === 'failed') throw computationFailure(computation.errorCode);
    await delay(signal);
    const response = await client.request<{ cncComputation: CncComputationResult | null }>({
      document: GET_CNC_COMPUTATION,
      variables: { id: computation.id },
      signal,
    });
    assertCurrent();
    if (!response.cncComputation) throw computationFailure();
    computation = response.cncComputation;
  }
}
