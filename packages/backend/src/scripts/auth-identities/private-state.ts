import { createHmac } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { writePrivateFileExclusively } from '../../auth/email-audit/private-file';

export function privateDirectory(path: string): string {
  const absolute = resolve(path);
  if (realpathSync(absolute) !== absolute) throw new Error('PRIVATE_PATH_REQUIRED');
  const metadata = lstatSync(absolute);
  if (!metadata.isDirectory() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o700)
    throw new Error('PRIVATE_DIRECTORY_REQUIRED');
  for (let ancestor = absolute; ; ancestor = dirname(ancestor)) {
    try {
      lstatSync(join(ancestor, '.git'));
      throw new Error('PRIVATE_PATH_INSIDE_GIT');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    if (dirname(ancestor) === ancestor) break;
  }
  return absolute;
}

export function privateText(path: string): string {
  const directory = privateDirectory(dirname(resolve(path)));
  const descriptor = openSync(join(directory, path.split('/').at(-1)!), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isFile() ||
      metadata.uid !== process.getuid?.() ||
      (metadata.mode & 0o777) !== 0o600 ||
      metadata.size > 8192
    )
      throw new Error('PRIVATE_FILE_REQUIRED');
    return readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

export function digestKey(path: string): Buffer {
  const content = privateText(path).trim();
  if (!/^[a-f0-9]{64}$/.test(content)) throw new Error('PRIVATE_DIGEST_KEY_REQUIRED');
  return Buffer.from(content, 'hex');
}
export function keyedDigest(key: Buffer, contents: unknown): string {
  return createHmac('sha256', key).update(JSON.stringify(contents)).digest('hex');
}

interface Checkpoint {
  sequence: number;
  lastUserId: string;
  databaseDigest: string;
}
export function checkpoints(path: string, databaseDigest: string) {
  const directory = privateDirectory(path);
  const entries = readdirSync(directory).sort();
  if (entries.some((entry) => !/^checkpoint-\d{12}\.json$/.test(entry)))
    throw new Error('CHECKPOINT_DIRECTORY_NOT_EMPTY');
  let latest: Checkpoint | undefined;
  for (let index = 0; index < entries.length; index++) {
    const parsed: unknown = JSON.parse(privateText(join(directory, entries[index])));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('sequence' in parsed) ||
      parsed.sequence !== index + 1 ||
      !('lastUserId' in parsed) ||
      typeof parsed.lastUserId !== 'string' ||
      !parsed.lastUserId ||
      !('databaseDigest' in parsed) ||
      parsed.databaseDigest !== databaseDigest
    )
      throw new Error('CHECKPOINT_INVALID');
    latest = parsed as Checkpoint;
  }
  return {
    lastUserId: latest?.lastUserId,
    save(lastUserId: string) {
      const sequence = (latest?.sequence ?? 0) + 1;
      const next = { sequence, lastUserId, databaseDigest };
      writePrivateFileExclusively(
        join(directory, `checkpoint-${String(sequence).padStart(12, '0')}.json`),
        [JSON.stringify(next)],
        8192,
      );
      latest = next;
    },
  };
}
