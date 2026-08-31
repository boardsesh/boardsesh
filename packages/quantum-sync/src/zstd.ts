import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { createZstdDecompress } from 'node:zlib';
import { QuantumSyncError } from './errors';
import { createPrivateQuantumTempFile, writeAllToFile, type PrivateQuantumTempFile } from './temp-file';
import type { ZstdStreamDecoder } from './types';

const ZSTD_FRAME_MAGIC = Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd);

export type DecompressedQuantumSnapshot = Readonly<{
  filePath: string;
  sha256: string;
  size: number;
  dispose(): Promise<void>;
}>;

/**
 * Stream a zstd artifact into a private file. A byte input is retained only as
 * a test/backwards-compatible seam; production passes the downloaded path.
 */
export async function decompressQuantumSnapshot(
  compressed: Uint8Array | string,
  maxOutputBytes: number,
  options: { decoder?: ZstdStreamDecoder; signal?: AbortSignal } = {},
): Promise<DecompressedQuantumSnapshot> {
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new QuantumSyncError('CONFIG_INVALID', 'Quantum decompression cap must be a positive safe integer.');
  }

  let temporaryInput: PrivateQuantumTempFile | null = null;
  let output: PrivateQuantumTempFile | null = null;
  try {
    let compressedFilePath: string;
    if (typeof compressed === 'string') {
      compressedFilePath = compressed;
    } else {
      temporaryInput = await createPrivateQuantumTempFile('boardsesh-quantum-zstd-input-', 'snapshot.zst');
      await writeAllToFile(temporaryInput.handle, compressed);
      await temporaryInput.close();
      compressedFilePath = temporaryInput.path;
    }

    output = await createPrivateQuantumTempFile('boardsesh-quantum-decompressed-', 'snapshot.sqlite3');
    if (!(await fileHasPrefix(compressedFilePath, ZSTD_FRAME_MAGIC))) {
      throw new QuantumSyncError('DECOMPRESSION_FAILED', 'Quantum snapshot is not a standard zstd frame.');
    }
    const digest = createHash('sha256');
    let outputBytes = 0;
    for await (const piece of (options.decoder ?? nodeZstdStreamDecoder)(compressedFilePath, options.signal)) {
      throwIfAborted(options.signal);
      if (!(piece instanceof Uint8Array)) {
        throw new QuantumSyncError('DECOMPRESSION_FAILED', 'Quantum zstd decoder yielded a non-byte chunk.');
      }
      if (piece.byteLength === 0) continue;
      outputBytes += piece.byteLength;
      if (outputBytes > maxOutputBytes) {
        throw new QuantumSyncError(
          'DECOMPRESSION_LIMIT_EXCEEDED',
          'Quantum snapshot exceeds the configured decompressed-size cap.',
        );
      }
      digest.update(piece);
      await writeAllToFile(output.handle, piece);
    }
    if (outputBytes === 0) {
      throw new QuantumSyncError('DECOMPRESSION_FAILED', 'Quantum zstd snapshot decompressed to zero bytes.');
    }
    await output.close();
    return Object.freeze({
      filePath: output.path,
      sha256: digest.digest('hex'),
      size: outputBytes,
      dispose: output.dispose,
    });
  } catch (error) {
    await output?.dispose();
    if (error instanceof QuantumSyncError || (error instanceof Error && error.name === 'AbortError')) throw error;
    throw new QuantumSyncError('DECOMPRESSION_FAILED', 'Quantum zstd decompression failed.', { cause: error });
  } finally {
    if (temporaryInput) await temporaryInput.dispose();
  }
}

export async function* nodeZstdStreamDecoder(
  compressedFilePath: string,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  const source = createReadStream(compressedFilePath);
  const decoder = createZstdDecompress();
  const abort = () => {
    const abortError = new Error('Quantum zstd decompression aborted');
    abortError.name = 'AbortError';
    source.destroy(abortError);
    decoder.destroy(abortError);
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();

  try {
    source.pipe(decoder);
    for await (const chunk of decoder) {
      const buffer = chunk as Buffer;
      yield new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    source.destroy();
    decoder.destroy();
  }
}

async function fileHasPrefix(filePath: string, prefix: Uint8Array): Promise<boolean> {
  const file = await open(filePath, 'r');
  try {
    const header = Buffer.alloc(prefix.byteLength);
    const { bytesRead } = await file.read(header, 0, prefix.byteLength, 0);
    return bytesRead === prefix.byteLength && prefix.every((byte, index) => header[index] === byte);
  } finally {
    await file.close();
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('Quantum sync aborted');
  error.name = 'AbortError';
  throw error;
}
