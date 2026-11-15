import { createHash } from 'node:crypto';
import { getFromS3Strict } from '../../storage/s3';
import { CncGeneratorError } from './generator-process';

/** Load only backend-authorized immutable object keys, with bounded I/O and memory. */
export async function loadCncGeneratorAssets(
  assets: Readonly<Record<string, { key: string; mime: string; sha256?: string }>>,
  signal: AbortSignal,
): Promise<Record<string, string>> {
  if (Object.keys(assets).length > 4) throw new CncGeneratorError('ASSET_LIMIT_EXCEEDED', false);
  const encoded: Record<string, string> = {};
  for (const [assetId, asset] of Object.entries(assets)) {
    signal.throwIfAborted();
    if (asset.mime !== 'image/svg+xml') throw new CncGeneratorError('ASSET_UNAVAILABLE', false);
    const object = await getFromS3Strict('private', asset.key, { signal });
    if (!object) throw new CncGeneratorError('ASSET_UNAVAILABLE', false);
    const abort = () => object.stream.destroy(new Error('CNC_ASSET_READ_ABORTED'));
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      if ((object.contentLength ?? 0) > 5 * 1024 * 1024) throw new CncGeneratorError('ASSET_LIMIT_EXCEEDED', false);
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of object.stream) {
        signal.throwIfAborted();
        const content = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += content.length;
        if (total > 5 * 1024 * 1024) throw new CncGeneratorError('ASSET_LIMIT_EXCEEDED', false);
        chunks.push(content);
      }
      const content = Buffer.concat(chunks);
      if (asset.sha256 && createHash('sha256').update(content).digest('hex') !== asset.sha256)
        throw new CncGeneratorError('ASSET_UNAVAILABLE', false);
      encoded[assetId] = content.toString('base64');
    } finally {
      signal.removeEventListener('abort', abort);
      object.stream.destroy();
    }
  }
  return encoded;
}
