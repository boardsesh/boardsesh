import { createHash } from 'node:crypto';
import { closeSync, fchmodSync, fstatSync, fsyncSync, openSync, writeFileSync } from 'node:fs';

export type PrivateFileErrorCode = 'EXISTS' | 'LIMIT' | 'UNAVAILABLE';

export class PrivateFileError extends Error {
  constructor(readonly code: PrivateFileErrorCode) {
    super('Private file could not be written.');
    this.name = 'PrivateFileError';
  }
}

/**
 * Creates `filename` exclusively with mode 0600 and streams `chunks` into it.
 * An existing path is never opened for writing. Chunks are pulled one at a
 * time, so a lazy iterable keeps memory bounded up to `maxBytes`. A failed
 * write leaves the partial file in place for diagnosis; only the returned
 * SHA-256 binds a completed file.
 */
export function writePrivateFileExclusively(filename: string, chunks: Iterable<string>, maxBytes: number) {
  let descriptor: number | undefined;
  try {
    let ownedDescriptor: number;
    try {
      ownedDescriptor = openSync(filename, 'wx', 0o600);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')
        throw new PrivateFileError('EXISTS');
      throw error;
    }
    descriptor = ownedDescriptor;
    fchmodSync(ownedDescriptor, 0o600);
    const metadata = fstatSync(ownedDescriptor);
    if (!metadata.isFile() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o600)
      throw new PrivateFileError('UNAVAILABLE');
    const hash = createHash('sha256');
    let totalBytes = 0;
    for (const chunk of chunks) {
      const bytes = Buffer.from(chunk);
      if (totalBytes + bytes.length > maxBytes) throw new PrivateFileError('LIMIT');
      writeFileSync(ownedDescriptor, bytes);
      hash.update(bytes);
      totalBytes += bytes.length;
    }
    fsyncSync(ownedDescriptor);
    closeSync(ownedDescriptor);
    descriptor = undefined;
    return { sha256: hash.digest('hex'), bytes: totalBytes };
  } catch (error) {
    if (error instanceof PrivateFileError) throw error;
    throw new PrivateFileError('UNAVAILABLE');
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        /* Completion is already rejected. */
      }
    }
  }
}
