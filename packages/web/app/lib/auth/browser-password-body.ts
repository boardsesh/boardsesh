/** Await cancellation itself before returning: the canonical physical-network
 * lock cannot outlive a detached body read or cancellation promise. */
export async function readSettledPasswordBody(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
  maximumBytes: number,
  timeoutMs = 5_000,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!body) throw new Error('PASSWORD_BODY_UNAVAILABLE');
  const reader = body.getReader();
  let interrupt = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const disarm = () => {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener('abort', interrupt);
  };
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    // The reader already owns disposal, but an initially aborted response must
    // not arm an unobserved rejecting timer while cancellation itself waits.
    if (signal.aborted) throw new Error('PASSWORD_BODY_UNAVAILABLE');
    const interrupted = new Promise<never>((_resolve, reject) => {
      interrupt = () => reject(new Error('PASSWORD_BODY_UNAVAILABLE'));
    });
    timer = setTimeout(interrupt, timeoutMs);
    signal.addEventListener('abort', interrupt, { once: true });
    while (true) {
      if (signal.aborted) throw new Error('PASSWORD_BODY_UNAVAILABLE');
      const chunk = await Promise.race([reader.read(), interrupted]);
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximumBytes) throw new Error('PASSWORD_BODY_UNAVAILABLE');
      chunks.push(chunk.value);
    }
    if (signal.aborted) throw new Error('PASSWORD_BODY_UNAVAILABLE');
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } catch {
    disarm();
    await reader.cancel().catch(() => undefined);
    throw new Error('PASSWORD_BODY_UNAVAILABLE');
  } finally {
    disarm();
    reader.releaseLock();
  }
}

/** Disposal is part of response ownership. Await a cancellation rejection before
 * suppressing it so cleanup cannot replace the original normalized refusal. */
export async function cancelSettledPasswordBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  try {
    await body?.cancel();
  } catch {
    /* Preserve the primary result after physical disposal settles. */
  }
}
