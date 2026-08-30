import { chmod, mkdtemp, open, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type PrivateQuantumTempFile = Readonly<{
  path: string;
  handle: FileHandle;
  close(): Promise<void>;
  dispose(): Promise<void>;
}>;

/** Create a private directory and mode-0600 file with idempotent cleanup. */
export async function createPrivateQuantumTempFile(
  directoryPrefix: string,
  filename: string,
): Promise<PrivateQuantumTempFile> {
  const directory = await mkdtemp(join(tmpdir(), directoryPrefix));
  const path = join(directory, filename);
  let handle: FileHandle | null = null;
  let disposed = false;

  try {
    await chmod(directory, 0o700);
    handle = await open(path, 'wx', 0o600);
    await chmod(path, 0o600);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  const openedHandle = handle;
  const close = async () => {
    if (!handle) return;
    const currentHandle = handle;
    handle = null;
    await currentHandle.close();
  };
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  };

  return Object.freeze({ path, handle: openedHandle, close, dispose });
}

export async function writeAllToFile(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (bytesWritten <= 0) throw new Error('Temporary file write made no progress.');
    offset += bytesWritten;
  }
}
