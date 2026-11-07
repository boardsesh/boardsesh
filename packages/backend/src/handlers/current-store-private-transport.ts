import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { AUTH_COMMAND_REQUEST_BYTES } from '@boardsesh/auth-protocol';

export function authenticatesPrivateAuth(presented: string | undefined, secret: string) {
  const actual = Buffer.from(presented ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function readPrivateAuthCommand(request: IncomingMessage): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onData = (_chunk: Buffer) => {};
  let onEnd = () => {};
  let onError = () => {};
  const pending = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    onData = (chunk) => {
      if (!Buffer.isBuffer(chunk) || (total += chunk.length) > AUTH_COMMAND_REQUEST_BYTES) {
        reject(new Error('Private auth body rejected'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    };
    onEnd = () => resolve(Buffer.concat(chunks));
    onError = () => reject(new Error('Private auth body unavailable'));
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onError);
  });
  try {
    const bytes = await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          request.destroy();
          reject(new Error('Private auth request deadline'));
        }, 2000);
      }),
    ]);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } finally {
    if (timer) clearTimeout(timer);
    request.off('data', onData);
    request.off('end', onEnd);
    request.off('error', onError);
    request.off('aborted', onError);
  }
}
