import 'server-only';
import { AuthBackendUnavailableError } from './auth-command-transport.server';

const BODY_BYTES = 65_536;
const fail = (): never => {
  throw new AuthBackendUnavailableError();
};

/** Shared bounded buffer before any operation publishes a credential or proof. */
export async function readProviderSecurityAuthBody(response: Response): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!response.body) return null;
  const declared = response.headers.get('Content-Length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > BODY_BYTES)) return fail();
  const reader = response.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new AuthBackendUnavailableError()), 2000);
  });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > BODY_BYTES) return fail();
      chunks.push(chunk.value);
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  } finally {
    if (timer) clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
