import { createHash, randomBytes } from 'node:crypto';
export { randomUUID } from 'node:crypto';

export const CryptoDigestAlgorithm = { SHA256: 'SHA-256' } as const;
export const CryptoEncoding = { HEX: 'hex', BASE64: 'base64' } as const;
export function getRandomBytes(count: number): Uint8Array {
  return new Uint8Array(randomBytes(count));
}
export async function digestStringAsync(
  algorithm: string,
  contents: string,
  options?: { encoding?: 'hex' | 'base64' },
): Promise<string> {
  if (algorithm !== CryptoDigestAlgorithm.SHA256) throw new Error('Unsupported test digest algorithm');
  return createHash('sha256')
    .update(contents)
    .digest(options?.encoding ?? 'hex');
}
export async function digest(algorithm: string, contents: ArrayBuffer | Uint8Array): Promise<ArrayBuffer> {
  if (algorithm !== CryptoDigestAlgorithm.SHA256) throw new Error('Unsupported test digest algorithm');
  return Uint8Array.from(createHash('sha256').update(new Uint8Array(contents)).digest()).buffer;
}
