import { z } from 'zod';

export const PROVIDER_SIGNIN_ACKNOWLEDGMENT_PATH = '/api/internal/auth/provider-signin/acknowledge';
export const providerSigninAcknowledgmentSchema = z
  .object({ outcome: z.enum(['none', 'recovered', 'identity_changed', 'unavailable']) })
  .strict();
export type ProviderSigninAcknowledgment = z.infer<typeof providerSigninAcknowledgmentSchema>['outcome'];

/** Canonical WWW metadata only. No flow selector, actor, UID or bearer is sent. */
export async function acknowledgeProviderSignin(
  canonicalOrigin: string,
  signal: AbortSignal,
  send: typeof fetch = fetch,
): Promise<ProviderSigninAcknowledgment> {
  try {
    const origin = new URL(canonicalOrigin);
    if (origin.protocol !== 'https:' || origin.origin !== canonicalOrigin || signal.aborted) return 'unavailable';
    const response = await send(`${canonicalOrigin}${PROVIDER_SIGNIN_ACKNOWLEDGMENT_PATH}`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      keepalive: false,
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal,
    });
    if (!response.body) return 'unavailable';
    const json = /^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '');
    const reader = response.body.getReader();
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 1024) {
          await reader.cancel();
          return 'unavailable';
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    if (!json || signal.aborted) return 'unavailable';
    const joined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const reply = providerSigninAcknowledgmentSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined)) as unknown,
    );
    const expectedStatus = reply.outcome === 'unavailable' ? 503 : reply.outcome === 'identity_changed' ? 409 : 200;
    return response.status === expectedStatus ? reply.outcome : 'unavailable';
  } catch {
    return 'unavailable';
  }
}
