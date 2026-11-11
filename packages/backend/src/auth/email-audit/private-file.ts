import { createHash } from 'node:crypto';
import { closeSync, fchmodSync, fstatSync, fsyncSync, openSync, unlinkSync, writeFileSync } from 'node:fs';

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
 * time, so a lazy iterable keeps memory bounded up to `maxBytes`. Only the
 * returned SHA-256 binds a completed file. A failed write leaves the partial
 * file for diagnosis, unless `removeOnFailure` asks for the file this call
 * created to be deleted so a rerun can use the same path.
 */
export function writePrivateFileExclusively(
  filename: string,
  chunks: Iterable<string>,
  maxBytes: number,
  options: { readonly removeOnFailure?: boolean } = {},
) {
  let descriptor: number | undefined;
  let created = false;
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
    created = true;
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
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        /* Completion is already rejected. */
      }
      descriptor = undefined;
    }
    // Only a path this call created exclusively is ever removed.
    if (created && options.removeOnFailure) {
      try {
        unlinkSync(filename);
      } catch {
        throw new PrivateFileError('UNAVAILABLE');
      }
    }
    if (error instanceof PrivateFileError) throw error;
    throw new PrivateFileError('UNAVAILABLE');
  }
}
