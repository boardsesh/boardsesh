export const AUTH_ADMISSION_RESPONSE_DEADLINE_MS = 1000;
export const MAX_UNSETTLED_AUTH_ADMISSION_READS = 8;
export const AUTH_ADMISSION_BATCH_SIZE = 128;

export class AuthAdmissionUnavailableError extends Error {
  constructor() {
    super('Authentication is temporarily unavailable');
    this.name = 'AuthAdmissionUnavailableError';
  }
}

export function isAuthAdmissionUnavailable(error: unknown): error is AuthAdmissionUnavailableError {
  return error instanceof AuthAdmissionUnavailableError;
}

let unsettledReads = 0;

/**
 * Bounds caller waiting and actual outstanding READS, without claiming SQL
 * cancellation. A timed-out call keeps its slot until its underlying read
 * settles. Never use this response race around a write transaction.
 */
export async function runAuthAdmissionRead<Result>(read: () => PromiseLike<Result>): Promise<Result> {
  if (unsettledReads >= MAX_UNSETTLED_AUTH_ADMISSION_READS) throw new AuthAdmissionUnavailableError();
  const deadline = performance.now() + AUTH_ADMISSION_RESPONSE_DEADLINE_MS;
  unsettledReads += 1;
  const operation = Promise.resolve().then(read);
  void operation.then(
    () => {
      unsettledReads -= 1;
    },
    () => {
      unsettledReads -= 1;
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      operation.catch(() => {
        throw new AuthAdmissionUnavailableError();
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new AuthAdmissionUnavailableError()), AUTH_ADMISSION_RESPONSE_DEADLINE_MS);
      }),
    ]);
    // A stalled event loop can run the settled read's microtask before its
    // overdue timer. Neither a late positive nor a late denial is authoritative.
    if (performance.now() >= deadline) throw new AuthAdmissionUnavailableError();
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
